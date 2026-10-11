// Payout partner callbacks. Owner: Nithya · Task: NI-C4 (stub from NI-C1). Spec: docs/specs/withdrawals.md §3c.
// deps.payouts.onUpdate(cb): completed → withdrawal completed + bankRef; failed → returned + ledger withdrawal_return
// (demo: treasury re-sends the XSGD). CAS on payout_pending; emit withdrawal.updated.

import type { WorkerDeps } from "../deps";

/** Subscribes to partner updates. Returns the unsubscribe fn. */
export function startPartnerCallbacks(deps: WorkerDeps): () => void {
  deps.log.debug("partner callbacks not subscribed (NI-C4)");
  return () => {};
}
