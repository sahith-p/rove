// Settlement: authorized payment → XSGD in the merchant's custodial account. Owner: Nithya · Task: NI-C2 (stub from NI-C1).
// Spec: docs/specs/settlement-xrpl.md §4, docs/specs/payments-stripe.md §7.
//
// POST /internal/settle (server.ts) awaits handleSettle() and then answers 202, so handleSettle must return quickly:
// validate, then start settlePayment() without awaiting it. The poller picks up anything a lost nudge missed.
// settlePayment: CAS authorized → settling → settle() on XRPL → db.completeSettlement() → emit payment.settled
// (with firstSale); retries with a fresh quote, then failed + Stripe auto-refund + payment.failed. Idempotent on paymentId.

import type { PaymentId } from "@rove/shared";
import type { InternalSettleReq } from "./contracts";
import type { WorkerDeps } from "./deps";
import { notImplemented } from "./errors";

export async function handleSettle(deps: WorkerDeps, body: InternalSettleReq): Promise<void> {
  void deps;
  void body;
  throw notImplemented("NI-C2", "Settlement");
}

export async function settlePayment(deps: WorkerDeps, paymentId: PaymentId): Promise<void> {
  void deps;
  void paymentId;
  throw notImplemented("NI-C2", "Settlement");
}

/** Every config.intervals.settlePoll ms: settle `authorized` payments. Returns a stopper. */
export function startSettlePoller(deps: WorkerDeps): () => void {
  deps.log.debug("settle poller not started (NI-C2)");
  return () => {};
}
