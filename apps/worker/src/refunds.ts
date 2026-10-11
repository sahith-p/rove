// Refunds. Owner: Nithya · Task: NI-C5 (stub from NI-C1). Spec: docs/specs/payments-stripe.md §6, withdrawals.md §4.
// POST /internal/refunds, idempotent on actionId (db.insertRefund has a unique action_id; db.getRefundByAction first):
// available ≥ amount check → settlement.refund (merchant → treasury) → Stripe refund (idempotencyKey "refund:" + actionId)
// → ledger refund_debit → db.addPaymentRefund → emit refund.completed (with payer) / refund.failed.
// Throw UserFacingError for things the agent should say ("Only S$4.20 is available; …").

import type { InternalRefundReq, InternalRefundRes } from "./contracts";
import type { WorkerDeps } from "./deps";
import { notImplemented } from "./errors";

export async function handleRefund(deps: WorkerDeps, body: InternalRefundReq): Promise<InternalRefundRes> {
  void deps;
  void body;
  throw notImplemented("NI-C5", "Refunds");
}
