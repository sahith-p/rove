// Expired withdrawal requests. Owner: Nithya · Task: NI-C7. Spec: docs/specs/withdrawals.md §3a–3c.
// A withdrawal is created `requested` when the agent proposes it, and only a human confirmation of its pending action
// (PENDING_ACTION_TTL_MS) moves it on. Once that window has passed (plus a minute for a confirmation claimed at the
// last second to reach /execute), nothing can approve it any more: CAS requested → cancelled, so it stops counting
// toward withdrawnToday (the daily limit) and doesn't sit in "Requested" forever. No ledger change (nothing was held).
//
// No event: the agent already told the merchant "This expired. Ask me again." when its pending action expired, and a
// withdrawal.updated `cancelled` would make it say "didn't go through … money is back in your balance", which is
// misleading for money that never moved.

import { format, PENDING_ACTION_TTL_MS, type Withdrawal } from "@rove/shared";
import type { WorkerDeps } from "./deps";

/** A `requested` withdrawal older than this can no longer be confirmed. */
export const WITHDRAWAL_REQUEST_TTL_MS = PENDING_ACTION_TTL_MS + 60_000;

export const EXPIRED_REQUEST_REASON = "Not confirmed in time; nothing was withdrawn.";

/** One pass. Returns the withdrawals it cancelled. Exported for tests and a manual run. */
export async function expireWithdrawalRequests(deps: WorkerDeps): Promise<Withdrawal[]> {
  const cutoff = deps.now().getTime() - WITHDRAWAL_REQUEST_TTL_MS;
  const stale = (await deps.db.listWithdrawalsByStatus(["requested"])).filter((w) => Date.parse(w.createdAt) <= cutoff);
  const cancelled: Withdrawal[] = [];
  for (const w of stale) {
    // CAS: a confirmation that won the race (requested → approved) leaves this a no-op.
    const done = await deps.db.transitionWithdrawal(w.id, ["requested"], "cancelled", { failureReason: EXPIRED_REQUEST_REASON });
    if (done) cancelled.push(done);
  }
  const log = deps.log.child("withdrawals");
  for (const w of cancelled) {
    log.info(`withdrawal request expired → cancelled  ${w.merchantId}  ${format(w.amount)}  ${w.id} (never confirmed; no money moved)`);
  }
  return cancelled;
}

/** Every config.intervals.expiry ms (first pass right away). Returns a stopper. */
export function startWithdrawalExpiryJob(deps: WorkerDeps): () => void {
  const log = deps.log.child("withdrawals");
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await expireWithdrawalRequests(deps);
    } catch (err) {
      log.error("withdrawal request expiry failed", { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.intervals.expiry);
  timer.unref?.();
  void tick();
  log.info("withdrawal request expiry started", { everyMs: deps.config.intervals.expiry, ttlMs: WITHDRAWAL_REQUEST_TTL_MS });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
