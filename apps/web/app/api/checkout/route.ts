// POST /api/checkout: invoice code or fixed-QR target → quote + Stripe PaymentIntent in the payer's currency
// (or a BNB deposit address, NI-C6; or an AUSD authorization, ausd lane). Owner: Nithya · Task: NI-B2
// Spec: docs/specs/payments-stripe.md §1. Request CheckoutReq → CheckoutRes. Errors: 400 invalid body / amount,
// 404 unknown code or shop, 409 invoice_paid / invoice_expired / invoice_cancelled / merchant_not_live /
// payment_in_progress, 501 bnb_not_ready, 502 stripe_error, 503 stripe_not_configured / ausd_not_configured.

import { CheckoutReq } from "@rove/shared";
import { getWebDeps } from "../_lib/deps";
import { json, readJson, route } from "../_lib/http";
import { runCheckout } from "./checkout";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const body = await readJson(req, CheckoutReq);
  return json(await runCheckout(getWebDeps(), body));
});
