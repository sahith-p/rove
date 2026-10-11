// Payout partner callbacks. Owner: Nithya · Task: NI-C4. Spec: docs/specs/withdrawals.md §3c.
// deps.payouts.onUpdate(cb) (StraitsX webhooks in production; the mock fires ~2s after createPayout). Each status
// carries the withdrawal id: completed → withdrawal completed + bankRef; failed → the treasury re-sends the XSGD,
// ledger withdrawal_return, status returned ("Bank rejected it; the money is back in your balance"). Applied inside
// serial(withdrawalId), so a callback that beats the pipeline's payout_pending write waits for it. See ./pipeline.ts.

import type { PartnerPayoutStatus } from "@rove/shared";
import type { WorkerDeps } from "../deps";
import { applyPayout, pipelineLog, schedule } from "./pipeline";

/** Applies one partner status update. Resolves when it's done; never throws. */
export function handlePartnerUpdate(deps: WorkerDeps, s: PartnerPayoutStatus): Promise<void> {
  pipelineLog(deps).debug("partner update", { withdrawalId: s.withdrawalId, partnerPayoutId: s.partnerPayoutId, status: s.status });
  return schedule(deps, s.withdrawalId, "partner callback", () => applyPayout(deps, s));
}

/** Subscribes to partner updates. Returns the unsubscribe fn. */
export function startPartnerCallbacks(deps: WorkerDeps): () => void {
  return deps.payouts.onUpdate((s) => {
    void handlePartnerUpdate(deps, s);
  });
}
