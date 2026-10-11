// The withdrawal pipeline. Owner: Nithya · Task: NI-C4 (stub from NI-C1). Spec: docs/specs/withdrawals.md §3c.
// POST /internal/withdrawals/:id/execute { actionId }, called only after a human confirmed.
// server.ts awaits executeWithdrawal() and then answers 202, so it must return quickly: do the synchronous part
// (db.approveWithdrawal: CAS requested → approved + ledger withdrawal_hold; throw UserFacingError on insufficient funds /
// unknown id) and then run the rest of the pipeline without awaiting it:
//   approved → onchain_pending (sweepToRedemption | sendToWallet) → onchain_settled (withdrawal_debit)
//   → payout_pending (payouts.createPayout, idempotencyKey = withdrawal id) → completed | returned (withdrawal_return)
//   failure before funds leave → failed (withdrawal_release). Emit withdrawal.updated per step. Every step is a CAS,
//   so a retried /execute resumes instead of repeating. Partner callbacks: ./partner.ts.

import type { WithdrawalId } from "@rove/shared";
import type { InternalExecuteWithdrawalReq } from "../contracts";
import type { WorkerDeps } from "../deps";
import { notImplemented } from "../errors";

export async function executeWithdrawal(deps: WorkerDeps, id: WithdrawalId, body: InternalExecuteWithdrawalReq): Promise<void> {
  void deps;
  void id;
  void body;
  throw notImplemented("NI-C4", "Withdrawals");
}

/** Boot: resume withdrawals left in approved / onchain_pending / payout_pending (db.listWithdrawalsByStatus). */
export async function resumeWithdrawals(deps: WorkerDeps): Promise<void> {
  deps.log.debug("withdrawal resume skipped (NI-C4)");
}
