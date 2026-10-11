// Reconciler. Owner: Nithya · Task: NI-C7 (stub from NI-C1). Spec: docs/specs/withdrawals.md §1.
// Invariant: ledger available + held == XSGD balance on the merchant's XRPL account (settlement.balance).
// Every config.intervals.reconcile ms for each live merchant; log drift loudly.

import type { MerchantId, Money } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import { notImplemented } from "./errors";

/** Returns a stopper. */
export function startReconciler(deps: WorkerDeps): () => void {
  deps.log.debug("reconciler not started (NI-C7)");
  return () => {};
}

export async function reconcileMerchant(deps: WorkerDeps, merchantId: MerchantId): Promise<{ ok: boolean; ledger: Money; onchain: Money }> {
  void deps;
  void merchantId;
  throw notImplemented("NI-C7", "Reconciliation");
}
