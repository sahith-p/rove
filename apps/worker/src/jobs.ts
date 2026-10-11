// Background jobs. Each start* returns its own stopper; startJobs returns one that stops them all (SIGTERM, tests).

import { startBnbWatcher } from "./bnb/index";
import type { WorkerDeps } from "./deps";
import { startExpiryJob } from "./expiry";
import { startReconciler } from "./reconcile";
import { startSettlePoller } from "./settle";
import { startWithdrawalExpiryJob } from "./withdrawal-expiry";
import { startAutoWithdrawJob } from "./withdrawals/auto";
import { startPartnerCallbacks } from "./withdrawals/partner";

export function startJobs(deps: WorkerDeps): () => void {
  const stoppers = [
    startSettlePoller(deps), // NI-C2
    startExpiryJob(deps), // NI-C2
    startPartnerCallbacks(deps), // NI-C4
    startAutoWithdrawJob(deps), // NI-C4
    startBnbWatcher(deps), // NI-C6
    startReconciler(deps), // NI-C7
    startWithdrawalExpiryJob(deps), // NI-C7: requested withdrawals past their confirmation window → cancelled
  ];
  return () => {
    for (const stop of stoppers) {
      try {
        stop();
      } catch (err) {
        deps.log.warn("job stopper threw", { err });
      }
    }
  };
}
