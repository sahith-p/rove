// AUSD relayer: submits the payer's signed ERC-3009 authorization on Base Sepolia and pays the gas, so the payer needs no
// ETH. Owner: Nithya · Spec: docs/specs/ausd-lane.md. Only the worker signs.
//
// Every ~2s, for each `created` ausd payment with a stored authorization (db.listAusdAwaitingRelay), one step of:
//
//   no relay tx yet ── expired? used/cancelled on-chain? invoice paid by someone else? ──► failed (nothing moved)
//        │ sign (simulates first) → db.setAusdRelayTx(hash) BEFORE broadcast → broadcast
//        ▼
//   relay tx recorded ── receipt success + Transfer(from → payTo, value) + 2 confirmations
//        │                   └─► db.claim("ausd:<hash>") → CAS created → authorized (payinTxHash) → scheduleSettle
//        ├─ pending / not yet visible → wait
//        └─ dropped or reverted → authorizationState false → sign again (≤ maxAttempts); true → failed
//
// Crash safety: the hash is stored before the tx leaves, so a restarted worker finds its own tx by receipt; it never
// credits a payment it can't prove, and authorizationState (per authorizer + nonce, one-shot on-chain) means a second relay
// of the same authorization can never move money twice.

import type { AusdRelayState } from "@rove/db";
import { DbConflictError } from "@rove/db";
import type { Payment } from "@rove/shared";
import type { Address, Hex } from "viem";
import type { WorkerDeps } from "../deps";
import type { Logger } from "../log";
import { scheduleSettle } from "../settle";
import { errorMessage } from "../settle/xrpl-errors";
import { RelayRevertedError, type AusdRelayChain, type AusdRelayerConfig } from "./chain";

export type RelayStep =
  | "sent" // signed, recorded, broadcast
  | "pending" // our tx isn't mined (or visible) yet
  | "confirming" // mined, waiting for confirmations
  | "authorized" // AUSD received: payment authorized
  | "retry" // transient problem; try again next tick
  | "failed" // payment failed (reason logged + payment.failed emitted)
  | "skipped"; // someone else moved the payment on

export interface RelayerState {
  /** Simulation reverts per payment (in memory: a restart gives each payment a fresh budget, bounded by validBefore). */
  reverts: Map<string, number>;
}

export interface RelayerOptions {
  config: AusdRelayerConfig;
  chain: AusdRelayChain;
  /** Called once a payment is authorized. Default: scheduleSettle (the settle poller would also pick it up). */
  onAuthorized?: (payment: Payment) => void;
  now?: () => number;
}

export function createRelayerState(): RelayerState {
  return { reverts: new Map() };
}

/** One pass over the queue, sequentially (one relayer key → ordered nonces). Never throws. */
export async function relayTick(deps: WorkerDeps, opts: RelayerOptions, state: RelayerState = createRelayerState()): Promise<Record<string, RelayStep>> {
  const log = deps.log.child("ausd");
  const out: Record<string, RelayStep> = {};
  let jobs: AusdRelayState[];
  try {
    jobs = await deps.db.listAusdAwaitingRelay(20);
  } catch (err) {
    log.error("couldn't list AUSD payments awaiting relay", { err: errorMessage(err) });
    return out;
  }
  for (const job of jobs) {
    try {
      out[job.payment.id] = await relayOne(deps, opts, state, job, log);
    } catch (err) {
      out[job.payment.id] = "retry";
      log.error("AUSD relay step crashed; retrying next tick", { paymentId: job.payment.id, err: errorMessage(err) });
    }
  }
  return out;
}

async function relayOne(deps: WorkerDeps, opts: RelayerOptions, state: RelayerState, job: AusdRelayState, log: Logger): Promise<RelayStep> {
  const { chain, config } = opts;
  const now = opts.now?.() ?? Date.now();
  const { payment, authorization: a } = job;
  const from = a.from as Address;
  const nonce = a.nonce as Hex;
  const ctx = { paymentId: payment.id, merchantId: payment.merchantId, from, value: a.value };

  if (a.to.toLowerCase() !== config.payTo.toLowerCase()) {
    // The web only stores authorizations to AUSD_PAY_TO; a mismatch means misconfiguration. Don't relay to someone else.
    return fail(deps, job, `authorization pays ${a.to}, not AUSD_PAY_TO`, log);
  }

  if (job.relayTxHash) {
    const hash = job.relayTxHash as Hex;
    const receipt = await chain.getReceipt(hash, a);
    if (receipt?.status === "success" && receipt.transferred) {
      const head = await chain.blockNumber();
      if (head - receipt.blockNumber + 1n < BigInt(config.confirmations)) return "confirming";
      return finalize(deps, opts, job, hash, log);
    }
    if (receipt) {
      log.warn("AUSD relay tx reverted or moved nothing", { ...ctx, txHash: hash, status: receipt.status });
    } else {
      if (await chain.txKnown(hash)) return "pending";
      // Not visible: just broadcast and still propagating, or dropped. Give it time before signing again.
      if (now - Date.parse(payment.updatedAt) < config.resendAfterMs) return "pending";
      log.warn("AUSD relay tx not seen by the node; signing it again", { ...ctx, txHash: hash });
    }
  }

  // No usable relay tx: (re)send, unless the authorization can no longer pay this payment.
  if (BigInt(Math.floor(now / 1000)) >= BigInt(a.validBefore)) return fail(deps, job, "authorization_expired: it was never relayed in time", log);
  if (job.relayAttempts >= config.maxAttempts) return fail(deps, job, `relay_failed after ${job.relayAttempts} transactions`, log);
  if (await chain.authorizationState(from, nonce)) {
    // Used or cancelled, and not by a tx of ours we can see: we can't prove the AUSD reached us, so we don't credit it.
    log.error("AUSD authorization already used or cancelled on-chain (not by our relay): check Basescan before crediting by hand", {
      ...ctx,
      nonce,
      lastRelayTx: job.relayTxHash,
    });
    return fail(deps, job, "authorization_used_elsewhere: the authorization was used or cancelled outside Rove's relay", log);
  }
  if (payment.invoiceId) {
    const invoice = await deps.db.getInvoice(payment.invoiceId);
    if (invoice?.status === "cancelled") return fail(deps, job, "invoice_cancelled before the AUSD moved", log);
    if (invoice?.status === "paid" && invoice.paymentId !== payment.id) return fail(deps, job, "invoice_already_paid before the AUSD moved", log);
  }

  let signed: { hash: Hex; serialized: Hex };
  try {
    signed = await chain.signRelay(a);
  } catch (err) {
    if (err instanceof RelayRevertedError) {
      const n = (state.reverts.get(payment.id) ?? 0) + 1;
      state.reverts.set(payment.id, n);
      log.warn("AUSD relay would revert", { ...ctx, attempt: n, err: err.message });
      if (n >= config.maxReverts) return fail(deps, job, `relay_reverted: ${err.message}`, log);
      return "retry";
    }
    log.error("couldn't prepare the AUSD relay tx (RPC down, or the relayer has no Base Sepolia ETH for gas?)", {
      ...ctx,
      relayer: chain.relayer,
      err: errorMessage(err),
    });
    return "retry";
  }
  // Record first: if we crash after broadcasting, the next run finds this tx by its hash.
  if (!(await deps.db.setAusdRelayTx(payment.id, signed.hash))) return "skipped";
  try {
    await chain.broadcast(signed.serialized);
    log.info("AUSD relay tx sent", { ...ctx, txHash: signed.hash, attempt: job.relayAttempts + 1 });
  } catch (err) {
    // Maybe it got there anyway ("already known"); the next tick looks it up and resends only if it's really gone.
    log.warn("AUSD relay broadcast failed; will check and resend", { ...ctx, txHash: signed.hash, err: errorMessage(err) });
  }
  return "sent";
}

async function finalize(deps: WorkerDeps, opts: RelayerOptions, job: AusdRelayState, hash: Hex, log: Logger): Promise<RelayStep> {
  const { payment, authorization: a } = job;
  const ctx = { paymentId: payment.id, merchantId: payment.merchantId, txHash: hash };
  // One relay tx credits one payment (also enforced by the unique payments_ausd_relay_tx index). A false claim means a
  // previous run got here and crashed before the CAS; the CAS below is idempotent, so carry on.
  await deps.db.claim(`ausd:${hash.toLowerCase()}`);
  let authorized: Payment | null;
  try {
    authorized = await deps.db.transitionPayment(payment.id, ["created"], "authorized", { payinTxHash: hash });
  } catch (err) {
    if (!(err instanceof DbConflictError)) throw err;
    // The invoice was paid another way while the AUSD was in flight: the AUSD is at AUSD_PAY_TO and must go back.
    log.error("invoice already paid by another payment: AUSD received but not credited; send it back to the payer by hand", {
      ...ctx,
      from: a.from,
      value: a.value,
    });
    return fail(deps, job, `invoice_already_paid: AUSD received in ${hash}, refund ${a.value} base units to ${a.from} by hand`, log, hash);
  }
  if (!authorized) return "skipped";
  log.info("AUSD received: payment authorized", { ...ctx, from: a.from, value: a.value });
  (opts.onAuthorized ?? ((p: Payment) => void scheduleSettle(deps, p)))(authorized);
  return "authorized";
}

async function fail(deps: WorkerDeps, job: AusdRelayState, reason: string, log: Logger, payinTxHash?: Hex): Promise<RelayStep> {
  const { payment } = job;
  const failed = await deps.db.transitionPayment(payment.id, ["created"], "failed", {
    failureReason: reason,
    ...(payinTxHash ? { payinTxHash } : {}),
  });
  if (!failed) return "skipped";
  log.warn("AUSD payment failed", { paymentId: payment.id, merchantId: payment.merchantId, reason });
  await deps.emit({ type: "payment.failed", paymentId: payment.id, merchantId: payment.merchantId, reason });
  return "failed";
}

/** Every config.pollMs: one relayTick. Returns a stopper. */
export function runAusdRelayer(deps: WorkerDeps, opts: RelayerOptions): () => void {
  const log = deps.log.child("ausd");
  const state = createRelayerState();
  let stopped = false;
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await relayTick(deps, opts, state);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.config.pollMs);
  timer.unref?.();
  void tick();
  log.info("AUSD relayer started", { relayer: opts.chain.relayer, payTo: opts.config.payTo, everyMs: opts.config.pollMs });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
