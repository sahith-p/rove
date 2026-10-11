// Create a withdrawal (status `requested`; no money moves). Owner: Nithya · Task: NI-C3 (stub from NI-C1).
// Spec: docs/specs/withdrawals.md §3a. POST /internal/withdrawals, called by the agent's propose_withdrawal tool.
// amount null = everything available; destination null = default bank account. Validate against db.getBalance,
// WITHDRAWAL_LIMITS (min, daily max via db.withdrawnToday), wallet trust line; fee S$0.00; needsStepUp (first withdrawal,
// bank account < 24h old, amount > S$200) → db.insertWithdrawal → toWithdrawalView (./view.ts).
// Every refusal is a UserFacingError the agent can say as is ("You have S$42.10 available.", "Add your bank first.").

import type { InternalCreateWithdrawalReq, WithdrawalView } from "../contracts";
import type { WorkerDeps } from "../deps";
import { notImplemented } from "../errors";

export async function createWithdrawal(deps: WorkerDeps, body: InternalCreateWithdrawalReq): Promise<WithdrawalView> {
  void deps;
  void body;
  throw notImplemented("NI-C3", "Withdrawals");
}
