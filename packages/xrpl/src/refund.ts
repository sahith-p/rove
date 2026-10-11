// refund() (NI-A5): merchant → TREASURY, same-currency payment of exactly `local` in the merchant's stablecoin
// (XSGD for SGD shops, EUR for euro shops, …; the currency comes from `local`).
// Deliberately NOT the spec's cross-currency RLUSD/SendMax version: a same-currency payment debits exactly the
// amount the ledger's refund_debit records, so ledger and XRPL stay equal. The customer is paid back by Stripe.
// Not deduplicated on InvoiceID (several partial refunds share a payment id); the worker is idempotent on actionId.

import type { Money } from "@rove/shared";
import type { EngineContext } from "./context";
import { assertPositive, toSettleResult } from "./settle";
import { submitTx } from "./submit";
import { buildIouPayment, invoiceIdFor } from "./tx";

export async function refund(ctx: EngineContext, input: { paymentId: string; merchantAddress: string; local: Money }): Promise<{ txHash: string }> {
  const local = assertPositive(input.local);
  const asset = ctx.asset(local.currency);
  const treasury = ctx.treasuryAddress();
  const wallet = await ctx.merchantWallet(input.merchantAddress);
  const tx = buildIouPayment({
    account: input.merchantAddress,
    destination: treasury,
    amount: { ...asset, value: local.amount },
    invoiceId: invoiceIdFor(input.paymentId),
  });
  const outcome = await submitTx(ctx, wallet, tx, { label: `refund ${input.paymentId}` });
  toSettleResult(outcome, local, asset); // throws unless exactly `local` moved
  return { txHash: outcome.hash };
}
