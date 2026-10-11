// Invoice / one-time QR / pay-request expiry. Owner: Nithya · Task: NI-C2.
// Every config.intervals.expiry ms: db.expireInvoices(deps.now()) (open + past expires_at → expired), log what changed.
// Pending actions expire on the agent side (it owns their lifecycle), not here.

import type { InvoiceKind } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import { errorMessage } from "./settle/xrpl-errors";

export interface ExpiryResult {
  count: number;
  byKind: Partial<Record<InvoiceKind, number>>;
}

/** One pass. Exported for tests and for a manual run. */
export async function expireOnce(deps: WorkerDeps): Promise<ExpiryResult> {
  const expired = await deps.db.expireInvoices(deps.now());
  const byKind: ExpiryResult["byKind"] = {};
  for (const inv of expired) byKind[inv.kind] = (byKind[inv.kind] ?? 0) + 1;
  if (expired.length) {
    deps.log.child("expiry").info("expired invoices", {
      count: expired.length,
      byKind,
      codes: expired.slice(0, 20).map((i) => i.code),
    });
  }
  return { count: expired.length, byKind };
}

/** Returns a stopper. */
export function startExpiryJob(deps: WorkerDeps): () => void {
  const log = deps.log.child("expiry");
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await expireOnce(deps);
    } catch (err) {
      log.error("expiry pass failed", { err: errorMessage(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.intervals.expiry);
  timer.unref?.();
  void tick();
  log.info("expiry job started", { everyMs: deps.config.intervals.expiry });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
