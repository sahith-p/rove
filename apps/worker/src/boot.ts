// Boot-time recovery. Owner: Nithya · Task: NI-C7 (first version from NI-C1).
// 1. resume withdrawals that were mid-pipeline when the process stopped (NI-C4)
// 2. replay events the agent never acknowledged (same envelope ids; the agent dedupes)
// Never throws: a failed recovery step is logged and the worker keeps serving.

import type { WorkerDeps } from "./deps";
import { resumeWithdrawals } from "./withdrawals/execute";

export async function boot(deps: WorkerDeps): Promise<void> {
  const log = deps.log.child("boot");

  try {
    await resumeWithdrawals(deps);
  } catch (err) {
    log.error("withdrawal resume failed", { err });
  }

  try {
    const pending = await deps.db.listUndeliveredEvents(200);
    if (pending.length === 0) return;
    log.info("replaying undelivered events", { count: pending.length });
    let delivered = 0;
    for (const envelope of pending) {
      if (await deps.emit.deliver(envelope)) delivered++;
    }
    log.info("event replay done", { delivered, remaining: pending.length - delivered });
  } catch (err) {
    log.error("event replay failed", { err });
  }
}
