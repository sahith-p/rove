// Auto-withdraw. Owner: Nithya · Task: NI-C4 (stub from NI-C1). Spec: docs/specs/withdrawals.md §3c (last bullet).
// PATCH /internal/merchants/:id/auto-withdraw { mode } → db.setAutoWithdraw (server.ts answers 204).
// Job: at 21:00 Asia/Singapore, for each live merchant with autoWithdraw "daily", create + approve a withdrawal of the
// full available balance to the default bank (skip if < S$1.00), then run the pipeline (./execute.ts).

import type { MerchantId } from "@rove/shared";
import type { InternalSetAutoWithdrawReq } from "../contracts";
import type { WorkerDeps } from "../deps";
import { notImplemented } from "../errors";

export async function setAutoWithdraw(deps: WorkerDeps, merchantId: MerchantId, body: InternalSetAutoWithdrawReq): Promise<void> {
  void deps;
  void merchantId;
  void body;
  throw notImplemented("NI-C4", "Auto-withdraw");
}

/** Checks every config.intervals.autoWithdraw ms whether the nightly run is due. Returns a stopper. */
export function startAutoWithdrawJob(deps: WorkerDeps): () => void {
  deps.log.debug("auto-withdraw job not started (NI-C4)");
  return () => {};
}
