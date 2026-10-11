// Invoice / one-time QR expiry. Owner: Nithya · Task: NI-C2 (stub from NI-C1).
// Every config.intervals.expiry ms: db.expireInvoices(deps.now()) (and db.expireActions if the agent doesn't).

import type { WorkerDeps } from "./deps";

/** Returns a stopper. */
export function startExpiryJob(deps: WorkerDeps): () => void {
  deps.log.debug("expiry job not started (NI-C2)");
  return () => {};
}
