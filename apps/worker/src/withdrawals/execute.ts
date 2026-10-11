// The withdrawal pipeline entry points. Owner: Nithya · Task: NI-C4. Spec: docs/specs/withdrawals.md §3c.
// POST /internal/withdrawals/:id/execute { actionId }, called only after a human confirmed. server.ts awaits
// executeWithdrawal() and then answers 202, so only the approve step runs synchronously (db.approveWithdrawal: one
// transaction doing CAS requested → approved, the available re-check and the withdrawal_hold); the rest of the pipeline
// (./pipeline.ts) runs in the background inside serial(id) and emits withdrawal.updated per step.
//
//   unknown id                → 404 withdrawal_not_found
//   available dropped below   → withdrawal failed (no ledger change), withdrawal.updated failed, 422 insufficient_funds
//   already approved or later → resume from its current status (a retried /execute never repeats a step)
//   completed/failed/returned → nothing to do (idempotent)
//   cancelled                 → 409 withdrawal_cancelled

import { format, type WithdrawalId } from "@rove/shared";
import type { InternalExecuteWithdrawalReq } from "../contracts";
import type { WorkerDeps } from "../deps";
import { UserFacingError } from "../errors";
import { serial } from "./lock";
import { advance, emitUpdate, IN_FLIGHT, pipelineLog, schedule } from "./pipeline";

export async function executeWithdrawal(deps: WorkerDeps, id: WithdrawalId, body: InternalExecuteWithdrawalReq): Promise<void> {
  const log = pipelineLog(deps);
  const r = await serial(id, () => deps.db.approveWithdrawal(id, body.actionId));

  if (r.ok) {
    log.info("withdrawal approved; funds held", { id, merchantId: r.withdrawal.merchantId, amount: r.withdrawal.amount.amount, actionId: body.actionId });
    void schedule(deps, id, "withdrawal pipeline", async () => {
      await emitUpdate(deps, r.withdrawal);
      await advance(deps, id);
    });
    return;
  }

  const w = r.withdrawal;
  if (!w) throw new UserFacingError("withdrawal_not_found", "I couldn't find that withdrawal. Say 'withdraw' to start a new one.", 404);

  if (r.reason === "insufficient_funds") {
    const { available } = await deps.db.getBalance(w.merchantId);
    const reason = `You have ${format(available)} available now, less than ${format(w.amount)}, so nothing was withdrawn.`;
    const failed = await serial(id, () => deps.db.transitionWithdrawal(id, ["requested"], "failed", { failureReason: reason }));
    log.warn("withdrawal refused at approval: not enough available", { id, merchantId: w.merchantId, amount: w.amount.amount, available: available.amount });
    if (failed) void schedule(deps, id, "withdrawal.updated failed", () => emitUpdate(deps, failed));
    throw new UserFacingError("insufficient_funds", reason);
  }

  // not_requested: someone (an earlier /execute, the boot resume) already approved it.
  if (IN_FLIGHT.includes(w.status)) {
    log.info("execute again: resuming from current status", { id, status: w.status });
    void schedule(deps, id, "withdrawal resume", () => advance(deps, id));
    return;
  }
  if (w.status === "cancelled") {
    throw new UserFacingError("withdrawal_cancelled", "That withdrawal was cancelled. Say 'withdraw' to start a new one.", 409);
  }
  if (w.status === "requested") {
    // approveWithdrawal saw it in another status a moment ago; a concurrent writer moved it back? Shouldn't happen.
    throw new UserFacingError("withdrawal_busy", "That withdrawal is still being set up. Try again in a moment.", 409);
  }
  log.info("execute again: withdrawal already finished", { id, status: w.status });
}

/**
 * Boot: pick up withdrawals the last process left mid-pipeline (withdrawals.md §3c "Recovery on boot").
 *   approved                         → send on-chain (nothing was sent: the CAS to onchain_pending never happened)
 *   onchain_pending, no tx hash      → logged for MANUAL REVIEW, never re-sent (it may have gone through)
 *   onchain_settled (bank)           → create the payout (the partner dedupes on the withdrawal id)
 *   payout_pending                   → payouts.getPayout and apply a final status
 * Resolves once each has gone as far as it can without waiting on the partner. Never throws per withdrawal.
 */
export async function resumeWithdrawals(deps: WorkerDeps): Promise<void> {
  const log = pipelineLog(deps);
  const open = await deps.db.listWithdrawalsByStatus(IN_FLIGHT);
  if (open.length === 0) return;
  log.info("resuming withdrawals", { count: open.length, ids: open.map((w) => `${w.id}:${w.status}`) });
  await Promise.all(open.map((w) => schedule(deps, w.id, "withdrawal resume", () => advance(deps, w.id))));
}
