// The withdrawal state machine's steps. Owner: Nithya · Task: NI-C4. Spec: docs/specs/withdrawals.md §3c.
//
//   approved ──► onchain_pending ──► onchain_settled ──► payout_pending ──► completed
//                     │                    │ (wallet: completed)   │
//                   failed               ledger                 returned
//              (withdrawal_release)  withdrawal_debit      (treasury re-sends XSGD, withdrawal_return)
//
// Every status change is a compare-and-set in the DB, and every ledger append is idempotent on (kind, withdrawal id),
// so running a step twice (retried /execute, boot resume, duplicate partner callback) never repeats its effect. Callers
// run these inside serial(withdrawalId, …) (./lock.ts) so steps for one withdrawal never interleave in this process.
// Each successful transition emits `withdrawal.updated` (awaited, so the agent sees statuses in order; emit never throws).

import {
  DECIMALS,
  fromMinor,
  toMinor,
  toUnits,
  type Merchant,
  type Money,
  type PartnerPayoutStatus,
  type Withdrawal,
  type WithdrawalId,
  type WithdrawalStatus,
} from "@rove/shared";
import type { WithdrawalPatch } from "@rove/db";
import type { WorkerDeps } from "../deps";
import type { Logger } from "../log";
import { serial } from "./lock";

export const RETURNED_REASON = "Bank rejected it; the money is back in your balance";
export const ONCHAIN_FAILED_REASON = "The transfer on XRPL didn't go through, so nothing left your balance. Try again in a minute.";
export const NO_TRUST_LINE_REASON = "That wallet can't receive XSGD yet: it needs an XSGD trust line. Nothing left your balance.";
export const NO_ACCOUNT_REASON = "Your shop's XRPL account isn't ready, so nothing left your balance.";

/** Statuses the pipeline still has work (or waiting) to do in. */
export const IN_FLIGHT: WithdrawalStatus[] = ["approved", "onchain_pending", "onchain_settled", "payout_pending"];
const AFTER_SWEEP: WithdrawalStatus[] = ["onchain_settled", "payout_pending"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function pipelineLog(deps: Pick<WorkerDeps, "log">): Logger {
  return deps.log.child("withdrawals");
}

/** Queue `fn` behind whatever is running for this withdrawal; errors are logged, never thrown. */
export function schedule(deps: WorkerDeps, id: WithdrawalId, what: string, fn: () => Promise<void>): Promise<void> {
  return serial(id, fn).catch((err) => pipelineLog(deps).error(`${what} crashed`, { id, err }));
}

export async function emitUpdate(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  await deps.emit({
    type: "withdrawal.updated",
    withdrawalId: w.id,
    merchantId: w.merchantId,
    status: w.status,
    amount: w.amount,
    ...(w.sweepTxHash ? { sweepTxHash: w.sweepTxHash } : {}),
    ...(w.bankRef ? { bankRef: w.bankRef } : {}),
    ...(w.failureReason ? { failureReason: w.failureReason } : {}),
  });
}

/**
 * CAS, then `book` (the step's ledger entry), then emit: by the time the agent hears about a status, the ledger already
 * matches the chain. Null (nothing booked, no event) when the withdrawal wasn't in `from`.
 */
async function move(
  deps: WorkerDeps,
  w: Withdrawal,
  from: WithdrawalStatus[],
  to: WithdrawalStatus,
  patch?: WithdrawalPatch,
  book?: () => Promise<unknown>,
) {
  const next = await deps.db.transitionWithdrawal(w.id, from, to, patch);
  if (!next) return null;
  if (book) await book();
  pipelineLog(deps).info(`withdrawal ${to}`, {
    id: w.id,
    merchantId: w.merchantId,
    amount: w.amount.amount,
    ...(patch?.sweepTxHash ? { tx: patch.sweepTxHash } : {}),
    ...(patch?.bankRef ? { bankRef: patch.bankRef } : {}),
  });
  await emitUpdate(deps, next);
  return next;
}

/**
 * Drives the withdrawal from its current status as far as it can go without waiting on the partner. Safe to call any
 * number of times (inside serial(id)): a step that already happened is skipped by its CAS.
 */
export async function advance(deps: WorkerDeps, id: WithdrawalId): Promise<void> {
  const log = pipelineLog(deps);
  for (let guard = 0; guard < 8; guard++) {
    const w = await deps.db.getWithdrawal(id);
    if (!w) {
      log.warn("withdrawal not found", { id });
      return;
    }
    let again = false;
    switch (w.status) {
      case "approved":
        again = await sendOnchain(deps, w);
        break;
      case "onchain_pending":
        again = await settleOrFlagOnchain(deps, w);
        break;
      case "onchain_settled":
        again = await afterOnchain(deps, w);
        break;
      case "payout_pending":
        await pollPayout(deps, w);
        break;
      default:
        return; // requested (needs approval) or finished
    }
    if (!again) return;
  }
  log.error("withdrawal pipeline looped without settling; check it", { id });
}

/** approved → onchain_pending → sweep / sendToWallet → onchain_settled (+ withdrawal_debit), or failed (+ release). */
async function sendOnchain(deps: WorkerDeps, w: Withdrawal): Promise<boolean> {
  const log = pipelineLog(deps);
  const merchant = await deps.db.getMerchant(w.merchantId);
  if (!merchant?.xrplAddress) {
    await fail(deps, w, ["approved"], NO_ACCOUNT_REASON, new Error("merchant has no XRPL account"));
    return false;
  }

  const pending = await move(deps, w, ["approved"], "onchain_pending");
  if (!pending) return true; // moved on under us: look again

  let txHash: string;
  try {
    txHash =
      w.destination.kind === "bank"
        ? (await deps.settlement.sweepToRedemption({ withdrawalId: w.id, merchantAddress: merchant.xrplAddress, local: w.amount })).txHash
        : (
            await deps.settlement.sendToWallet({
              withdrawalId: w.id,
              merchantAddress: merchant.xrplAddress,
              local: w.amount,
              address: w.destination.address,
            })
          ).txHash;
  } catch (err) {
    await fail(deps, pending, ["onchain_pending"], onchainFailureReason(err, w), err);
    return false;
  }

  let settled: Withdrawal | null;
  try {
    settled = await move(deps, pending, ["onchain_pending"], "onchain_settled", { sweepTxHash: txHash }, () => debit(deps, w));
  } catch (err) {
    // The XSGD left but we couldn't record it: the row stays onchain_pending without a hash, which resume treats as
    // "needs a human" rather than sending again. Log the hash so they can finish it by hand.
    log.error("on-chain transfer validated but not recorded: MANUAL REVIEW", { id: w.id, merchantId: w.merchantId, tx: txHash, err });
    throw err;
  }
  if (!settled) {
    log.error("on-chain transfer validated but the withdrawal had moved on: MANUAL REVIEW", { id: w.id, tx: txHash });
    return false;
  }
  return true;
}

/** −held: the XSGD left the merchant's account. Idempotent on (withdrawal_debit, id). */
const debit = (deps: WorkerDeps, w: Withdrawal) =>
  deps.db.appendLedger({ merchantId: w.merchantId, kind: "withdrawal_debit", amount: w.amount, ref: w.id });

/** Failure before any XSGD left: CAS to failed, then release the hold. */
async function fail(deps: WorkerDeps, w: Withdrawal, from: WithdrawalStatus[], reason: string, err: unknown): Promise<void> {
  const failed = await deps.db.transitionWithdrawal(w.id, from, "failed", { failureReason: reason });
  if (!failed) return;
  await deps.db.appendLedger({ merchantId: w.merchantId, kind: "withdrawal_release", amount: w.amount, ref: w.id });
  pipelineLog(deps).warn("withdrawal failed; hold released", { id: w.id, merchantId: w.merchantId, amount: w.amount.amount, err: errText(err) });
  await emitUpdate(deps, failed);
}

export function onchainFailureReason(err: unknown, w: Pick<Withdrawal, "destination">): string {
  if (w.destination.kind !== "xrpl_wallet") return ONCHAIN_FAILED_REASON;
  // The real engine's sendToWallet pre-check throws XrplDestinationError with a message written for the merchant.
  if (err instanceof Error && err.name === "XrplDestinationError" && err.message) return `${err.message} Nothing left your balance.`;
  if (/trust ?line|tecNO_LINE|tecNO_AUTH|tecPATH_DRY/i.test(errText(err))) return NO_TRUST_LINE_REASON;
  return ONCHAIN_FAILED_REASON;
}

/**
 * Resume found onchain_pending. With a hash the transfer is known to have validated: record it. Without one we can't
 * tell whether the transaction went through, and sending again could pay twice, so a human checks the account
 * (Payment with InvoiceID = sha256(withdrawal id)) and finishes it.
 */
async function settleOrFlagOnchain(deps: WorkerDeps, w: Withdrawal): Promise<boolean> {
  if (w.sweepTxHash) {
    await move(deps, w, ["onchain_pending"], "onchain_settled", { sweepTxHash: w.sweepTxHash }, () => debit(deps, w));
    return true;
  }
  pipelineLog(deps).error(
    "withdrawal stuck in onchain_pending with no tx hash: NOT re-sending (could pay twice). MANUAL REVIEW: look for a Payment " +
      "from the merchant account with InvoiceID = sha256(withdrawal id); if it validated, set onchain_settled + sweep_tx_hash " +
      "and append withdrawal_debit; if not, set failed and append withdrawal_release",
    { id: w.id, merchantId: w.merchantId, amount: w.amount.amount, destination: w.destination.kind },
  );
  return false;
}

/** onchain_settled: make sure the debit is booked, then wallet → completed, bank → create the payout. */
async function afterOnchain(deps: WorkerDeps, w: Withdrawal): Promise<boolean> {
  const log = pipelineLog(deps);
  // Idempotent: normally a no-op (booked with the onchain_settled CAS); covers a crash between the CAS and the append.
  await debit(deps, w);

  if (w.destination.kind === "xrpl_wallet") {
    await move(deps, w, ["onchain_settled"], "completed");
    return false;
  }

  const bank = await deps.db.getBankAccount(w.destination.bankAccountId);
  if (!bank) {
    log.error("bank account for withdrawal is gone; payout needs MANUAL REVIEW", { id: w.id, bankAccountId: w.destination.bankAccountId });
    return false;
  }

  let payout: PartnerPayoutStatus | null = null;
  for (const [attempt, delay] of [0, 250, 1000].entries()) {
    if (delay) await sleep(delay);
    try {
      payout = await deps.payouts.createPayout({ withdrawalId: w.id, beneficiaryId: bank.beneficiaryId, amount: w.amount, idempotencyKey: w.id });
      break;
    } catch (err) {
      log.warn("createPayout failed", { id: w.id, attempt: attempt + 1, err: errText(err) });
    }
  }
  if (!payout) {
    log.error("payout partner unreachable; withdrawal waits in onchain_settled (re-execute or restart resumes it)", { id: w.id });
    return false;
  }

  await move(deps, w, ["onchain_settled"], "payout_pending", { partnerPayoutId: payout.partnerPayoutId });
  if (payout.status !== "pending") await applyPayout(deps, payout);
  return false;
}

/** payout_pending on resume / re-execute: ask the partner instead of waiting for a callback we may have missed. */
async function pollPayout(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  if (!w.partnerPayoutId) {
    pipelineLog(deps).error("payout_pending without a partner payout id: MANUAL REVIEW", { id: w.id });
    return;
  }
  try {
    const s = await deps.payouts.getPayout(w.partnerPayoutId);
    if (s.status !== "pending") await applyPayout(deps, s);
  } catch (err) {
    pipelineLog(deps).warn("getPayout failed; waiting for the partner callback", { id: w.id, err: errText(err) });
  }
}

/**
 * A final partner status (callback or poll) for a bank withdrawal. completed → completed + bank ref. failed → the
 * treasury re-sends the XSGD from its float (demo stand-in for StraitsX returning it), withdrawal_return, returned.
 * Accepts onchain_settled too: a callback can beat the payout_pending CAS when the process died in between.
 */
export async function applyPayout(deps: WorkerDeps, s: PartnerPayoutStatus): Promise<void> {
  const log = pipelineLog(deps);
  if (s.status === "pending") return;
  const w = await deps.db.getWithdrawal(s.withdrawalId);
  if (!w || w.destination.kind !== "bank") {
    log.warn("partner update for an unknown or non-bank withdrawal; ignored", { withdrawalId: s.withdrawalId, partnerPayoutId: s.partnerPayoutId });
    return;
  }
  if (!AFTER_SWEEP.includes(w.status)) {
    log.debug("partner update for a withdrawal that's past it; ignored", { id: w.id, status: w.status, partner: s.status });
    return;
  }
  if (w.partnerPayoutId && w.partnerPayoutId !== s.partnerPayoutId) {
    log.warn("partner update for a different payout; ignored", { id: w.id, ours: w.partnerPayoutId, theirs: s.partnerPayoutId });
    return;
  }

  if (s.status === "completed") {
    await move(deps, w, AFTER_SWEEP, "completed", { partnerPayoutId: s.partnerPayoutId, ...(s.reference ? { bankRef: s.reference } : {}) });
    return;
  }

  // failed: put the XSGD back on the merchant's account before telling anyone it's back.
  const merchant = await deps.db.getMerchant(w.merchantId);
  if (!merchant?.xrplAddress) {
    log.error("payout bounced but the merchant has no XRPL account to return it to: MANUAL REVIEW", { id: w.id });
    return;
  }
  const returned = await returnToMerchant(deps, w, merchant);
  if (!returned) return;
  const next = await move(deps, w, AFTER_SWEEP, "returned", { partnerPayoutId: s.partnerPayoutId, failureReason: RETURNED_REASON }, () =>
    deps.db.appendLedger({ merchantId: w.merchantId, kind: "withdrawal_return", amount: returned.delivered, ref: w.id }),
  );
  if (!next) {
    log.error("return transfer sent but the withdrawal had moved on: MANUAL REVIEW (possible double return)", { id: w.id, tx: returned.txHash });
    return;
  }
  log.warn("payout bounced; XSGD returned to the merchant", { id: w.id, partnerReason: s.failureReason, tx: returned.txHash });
}

/** Treasury → merchant, from the treasury's XSGD float (no swap). Credits what was delivered. Null after 3 failed tries. */
async function returnToMerchant(deps: WorkerDeps, w: Withdrawal, merchant: Merchant): Promise<{ txHash: string; delivered: Money } | null> {
  const log = pipelineLog(deps);
  for (const [attempt, delay] of [0, 500, 2000].entries()) {
    if (delay) await sleep(delay);
    try {
      const r = await deps.settlement.settle({ paymentId: w.id, merchantAddress: merchant.xrplAddress!, local: w.amount, sendMaxUsd: "0", from: "SGD" });
      const delivered = deliveredMoney(r.delivered, w.amount);
      if (toMinor(delivered) !== toMinor(w.amount)) {
        log.warn("return delivered a different amount than the withdrawal; crediting what arrived", { id: w.id, delivered: delivered.amount, amount: w.amount.amount });
      }
      return { txHash: r.txHash, delivered };
    } catch (err) {
      log.warn("return transfer failed", { id: w.id, attempt: attempt + 1, err: errText(err) });
    }
  }
  log.error("payout bounced and the XSGD return failed 3 times: withdrawal stays put; restart (resume) retries it. MANUAL REVIEW if it persists", {
    id: w.id,
    merchantId: w.merchantId,
  });
  return null;
}

/** meta.delivered_amount → Money in the withdrawal's currency (floor to the cent; never more than was delivered). */
function deliveredMoney(delivered: string, fallback: Money): Money {
  try {
    return fromMinor(toUnits(delivered, DECIMALS[fallback.currency], "floor"), fallback.currency);
  } catch {
    return fallback;
  }
}
