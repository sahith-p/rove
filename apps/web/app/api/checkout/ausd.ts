// method=ausd branch of POST /api/checkout (Agora AUSD on Base Sepolia, gasless for the payer; docs/specs/ausd-lane.md).
// Owner: Nithya. Like bnb, an AUSD payer is always charged in USD (quote.usd). The target is already resolved and
// validated by checkout.ts.
//
// Inserts a `created` ausd payment (like the card path, method "ausd") and returns CheckoutRes.ausd: the ERC-3009
// TransferWithAuthorization the payer's wallet signs. The page then POSTs { paymentId, from, signature } to
// /api/ausd/authorize; the worker relays it and pays the gas. 503 ausd_not_configured when AUSD_PAY_TO isn't set.
//
// An invoice already paid (or with a signed AUSD authorization being relayed) → 409, never a second payment. An unexpired,
// unsigned ausd payment for the same invoice is handed back: the nonce is derived from the payment id, so the page signs
// the same authorization again.

import type { z } from "zod";
import { newId, type CheckoutRes, type Payment } from "@rove/shared";
import { ausdCharge, buildAusdCheckout, getAusdDeps } from "../_lib/ausd";
import type { WebDeps } from "../_lib/deps";
import { HttpError } from "../_lib/http";
import type { CheckoutTarget } from "./target";

const PAID: ReadonlySet<Payment["status"]> = new Set(["authorized", "settling", "settled", "partially_refunded", "refunded"]);
/** A reused quote must leave the payer time to open their wallet and sign. */
const REUSE_MIN_REMAINING_MS = 20_000;
const REUSE_SCAN = 50;

export async function checkoutAusd(deps: WebDeps, target: CheckoutTarget, now = Date.now()): Promise<z.infer<typeof CheckoutRes>> {
  const { config } = getAusdDeps();

  if (target.invoiceId) {
    const same = (await deps.db.listPayments(target.merchantId, REUSE_SCAN)).filter((p) => p.invoiceId === target.invoiceId); // newest first
    if (same.some((p) => PAID.has(p.status))) throw new HttpError(409, "invoice_paid", "This has already been paid.");
    for (const p of same) {
      if (p.method !== "ausd" || p.status !== "created" || !p.quote || !p.charge) continue;
      const relay = await deps.db.getAusdRelay(p.id);
      if (relay) throw new HttpError(409, "payment_in_progress", "An AUSD payment for this is already going through.");
      if (Date.parse(p.quote.expiresAt) - now >= REUSE_MIN_REMAINING_MS) {
        return { paymentId: p.id, local: p.local, quote: p.quote, charge: p.charge, ausd: buildAusdCheckout(p, config) };
      }
    }
  }

  const quote = await deps.settlement.quote({ local: target.local });
  const charge = ausdCharge(quote);
  const payment = await deps.db.insertPayment({
    id: newId("pay"),
    merchantId: target.merchantId,
    source: target.source,
    invoiceId: target.invoiceId,
    lines: target.lines,
    local: target.local,
    quote,
    charge,
    method: "ausd",
    payer: target.payer,
  });
  return { paymentId: payment.id, local: target.local, quote, charge, ausd: buildAusdCheckout(payment, config) };
}
