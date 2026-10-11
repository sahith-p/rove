// BNB pay-in watcher core: Transfer logs of the test stablecoin → authorized payments. Owner: Nithya · Task: NI-C6.
// Spec: docs/specs/bnb-lane.md. index.ts runs poll() every BSC_POLL_MS; tests drive it with a fake ChainSource.
//
// poll():
//   cursor = last block fully handled (in memory; on boot it starts `rescanBlocks` back, claim() makes that safe)
//   logs   = the token's Transfer logs in (cursor, head]
//   a log with fewer than `confirmations` (3) confirmations, i.e. block > head − 2, waits (logged once if it's ours)
//   confirmed logs, in (block, logIndex) order → handleDeposit; an unexpected error stops the pass and holds the
//   cursor before that block, so it's retried next poll
//
// handleDeposit (one confirmed log):
//   payment = db.getPaymentByDepositAddress(to)          unknown address → ignored (nothing written)
//   payment not `created`                                → "extra": a second deposit, logged loudly, refund by hand
//   value < charge in token base units (bigint)          → "underpaid": logged loudly, left `created`
//   paid more than LATE_GRACE (1 h) after quote expiry   → "too_late": left `created`, refund by hand
//   else CAS created → authorized { method: bnb, payinTxHash }   (late but within the hour: accepted, logged)
//        DbConflictError (the invoice was paid another way) → "duplicate_invoice", refund by hand
//   then db.claim("bsc:<txHash>:<logIndex>"): false → this log was handled before a restart; stay silent
//   authorized → scheduleSettle (settle.ts: per-merchant ordering; the settle poller is the fallback)
// The CAS runs before the claim on purpose: it's idempotent by itself (only `created` moves), and claiming last means
// a crash between the two can never strand a confirmed deposit. Refunds on this lane are manual (bnb-lane.md §6).

import { formatUnits } from "viem";
import { DbConflictError } from "@rove/db";
import { format, toUnits, type Payment } from "@rove/shared";
import type { WorkerDeps } from "../deps";
import type { Logger } from "../log";
import { scheduleSettle } from "../settle";
import { errorMessage } from "../settle/xrpl-errors";
import type { ChainSource, TransferLog } from "./source";

export interface WatcherOptions {
  decimals: number;
  confirmations: number;
  rescanBlocks: bigint;
  lateGraceMs: number;
  /** "now" (default): scheduleSettle right after authorizing. "poller": leave it `authorized` for the settle poller. */
  settle?: "now" | "poller";
  /** For logs, e.g. "tUSDT". */
  symbol?: string;
}

export type DepositOutcome =
  | { kind: "ignored"; reason: "unknown_address" | "not_bnb" }
  | { kind: "authorized"; paymentId: string; late: boolean }
  | { kind: "underpaid"; paymentId: string; expected: bigint; paid: bigint }
  | { kind: "extra"; paymentId: string; status: Payment["status"] | "unknown" }
  | { kind: "too_late"; paymentId: string }
  | { kind: "duplicate_invoice"; paymentId: string }
  | { kind: "unpriced"; paymentId: string }
  | { kind: "already_processed"; paymentId: string };

export interface PollResult {
  head: bigint;
  /** Highest block with enough confirmations. */
  safe: bigint;
  /** Cursor after this poll. */
  cursor: bigint;
  outcomes: DepositOutcome[];
  /** Logs seen but still waiting for confirmations. */
  pending: number;
}

export interface BnbWatcher {
  poll(): Promise<PollResult>;
  /** Last block fully handled; null before the first poll. */
  cursor(): bigint | null;
}

/** Idempotency key for one log (processed table). */
export const claimKey = (l: Pick<TransferLog, "txHash" | "logIndex">): string => `bsc:${l.txHash.toLowerCase()}:${l.logIndex}`;

/** What the payer was asked to send, in token base units. Null if the payment has no USD price (a bug). */
export function expectedUnits(payment: Pick<Payment, "charge" | "quote">, decimals: number): bigint | null {
  const due = payment.charge ?? payment.quote?.usd;
  if (!due || due.currency !== "USD") return null;
  return toUnits(due.amount, decimals, "ceil");
}

function isConflict(err: unknown): boolean {
  return err instanceof DbConflictError || (err instanceof Error && err.name === "DbConflictError");
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10;

export async function handleDeposit(
  deps: WorkerDeps,
  source: ChainSource,
  opts: WatcherOptions,
  l: TransferLog,
  log: Logger = deps.log.child("bnb"),
): Promise<DepositOutcome> {
  const payment = await deps.db.getPaymentByDepositAddress(l.to);
  if (!payment) {
    log.debug("transfer to an address that isn't ours; ignored", { to: l.to, txHash: l.txHash });
    return { kind: "ignored", reason: "unknown_address" };
  }
  if (payment.method !== "bnb") {
    log.warn("deposit address belongs to a non-bnb payment; ignored", { paymentId: payment.id, method: payment.method, txHash: l.txHash });
    return { kind: "ignored", reason: "not_bnb" };
  }

  const tok = (units: bigint) => `${formatUnits(units, opts.decimals)} ${opts.symbol ?? "token"}`;
  const ctx = {
    paymentId: payment.id,
    merchantId: payment.merchantId,
    txHash: l.txHash,
    logIndex: l.logIndex,
    block: l.blockNumber.toString(),
    from: l.from,
    to: l.to,
    paid: tok(l.value),
  };

  const expected = expectedUnits(payment, opts.decimals);
  let outcome: DepositOutcome;
  let authorized: Payment | null = null;
  let lateByMs = 0;

  if (payment.status !== "created") {
    outcome = { kind: "extra", paymentId: payment.id, status: payment.status };
  } else if (expected === null) {
    outcome = { kind: "unpriced", paymentId: payment.id };
  } else if (l.value < expected) {
    outcome = { kind: "underpaid", paymentId: payment.id, expected, paid: l.value };
  } else {
    const paidAt = (await source.blockTime(l.blockNumber)).getTime();
    const expiresAt = Date.parse(payment.quote?.expiresAt ?? payment.createdAt);
    lateByMs = Number.isFinite(expiresAt) ? paidAt - expiresAt : 0;
    if (lateByMs > opts.lateGraceMs) {
      outcome = { kind: "too_late", paymentId: payment.id };
    } else {
      try {
        authorized = await deps.db.transitionPayment(payment.id, ["created"], "authorized", { method: "bnb", payinTxHash: l.txHash });
        outcome = authorized
          ? { kind: "authorized", paymentId: payment.id, late: lateByMs > 0 }
          : { kind: "extra", paymentId: payment.id, status: (await deps.db.getPayment(payment.id))?.status ?? "unknown" };
      } catch (err) {
        if (!isConflict(err)) throw err;
        outcome = { kind: "duplicate_invoice", paymentId: payment.id };
      }
    }
  }

  if (authorized && opts.settle !== "poller") void scheduleSettle(deps, authorized); // never rejects

  let first: boolean;
  try {
    first = await deps.db.claim(claimKey(l));
  } catch (err) {
    if (!authorized) throw err; // nothing happened yet: retry the whole log next poll
    log.warn("deposit authorized but claiming its log failed (harmless: the payment can't be authorized twice)", { ...ctx, err: errorMessage(err) });
    first = true;
  }
  if (!first && !authorized) {
    log.debug("log already handled (before a restart); skipped", ctx);
    return { kind: "already_processed", paymentId: payment.id };
  }

  const due = expected === null ? undefined : tok(expected);
  switch (outcome.kind) {
    case "authorized":
      if (outcome.late) {
        log.warn("late deposit accepted: paid after the quote expired (within the 1 h grace); Rove absorbs the drift, settle re-quotes", {
          ...ctx,
          due,
          lateByMin: minutes(lateByMs),
        });
      }
      log.info("deposit confirmed: payment authorized", { ...ctx, due, local: format(payment.local), settle: opts.settle ?? "now" });
      break;
    case "underpaid":
      log.error("UNDERPAID deposit: payment NOT authorized, left created. A top-up to the same address doesn't add up; refund this deposit by hand", {
        ...ctx,
        due,
        short: tok(outcome.expected - outcome.paid),
      });
      break;
    case "extra":
      log.error(`EXTRA deposit to a payment that is already ${outcome.status}: not credited again; refund the payer by hand`, ctx);
      break;
    case "too_late":
      log.error("deposit arrived more than 1 h after the quote expired: NOT authorized, left created; refund the payer by hand", {
        ...ctx,
        due,
        lateByMin: minutes(lateByMs),
      });
      break;
    case "duplicate_invoice":
      log.error("deposit for an invoice that another payment already paid: NOT authorized; refund the payer by hand", ctx);
      break;
    case "unpriced":
      log.error("bnb payment has no USD charge to compare against: NOT authorized (bug)", ctx);
      break;
  }
  return outcome;
}

export function createBnbWatcher(deps: WorkerDeps, source: ChainSource, opts: WatcherOptions): BnbWatcher {
  const log = deps.log.child("bnb");
  const confirmations = BigInt(Math.max(1, opts.confirmations));
  let cursor: bigint | null = null;
  /** Logs seen before they had enough confirmations: key → block. Our own ones are logged once. */
  const waiting = new Map<string, bigint>();

  async function notePending(l: TransferLog, head: bigint): Promise<void> {
    const key = claimKey(l);
    if (waiting.has(key)) return;
    waiting.set(key, l.blockNumber);
    const payment = await deps.db.getPaymentByDepositAddress(l.to);
    if (!payment || payment.method !== "bnb") return;
    log.info("deposit seen, waiting for confirmations", {
      paymentId: payment.id,
      txHash: l.txHash,
      paid: `${formatUnits(l.value, opts.decimals)} ${opts.symbol ?? "token"}`,
      confirmations: `${head - l.blockNumber + 1n}/${confirmations}`,
    });
  }

  async function poll(): Promise<PollResult> {
    const head = await source.head();
    if (cursor === null) {
      cursor = head > opts.rescanBlocks ? head - opts.rescanBlocks : -1n;
      log.info("watching Transfer logs", { fromBlock: (cursor + 1n).toString(), head: head.toString(), confirmations: Number(confirmations) });
    }
    const safe = head - (confirmations - 1n);
    const outcomes: DepositOutcome[] = [];
    if (head <= cursor) return { head, safe, cursor, outcomes, pending: 0 };

    const logs = (await source.transfers(cursor + 1n, head))
      .filter((l) => l.blockNumber > cursor!)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

    let next = safe > cursor ? safe : cursor;
    let pending = 0;
    for (const l of logs) {
      if (l.blockNumber > safe) {
        pending++;
        await notePending(l, head);
        continue;
      }
      try {
        outcomes.push(await handleDeposit(deps, source, opts, l, log));
      } catch (err) {
        log.error("handling a deposit failed; will retry from its block next poll", { txHash: l.txHash, block: l.blockNumber.toString(), err: errorMessage(err) });
        next = l.blockNumber - 1n;
        break;
      }
    }
    cursor = next;
    for (const [key, block] of waiting) if (block <= cursor) waiting.delete(key);
    return { head, safe, cursor, outcomes, pending };
  }

  return { poll, cursor: () => cursor };
}
