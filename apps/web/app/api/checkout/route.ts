// POST /api/checkout: invoice code or fixed-QR target → quote + Stripe PaymentIntent in the payer's currency
// (or a BNB deposit address, NI-C6; or an AUSD authorization, ausd lane). Owner: Nithya · Task: NI-B2
// Spec: docs/specs/payments-stripe.md §1. Request CheckoutReq → CheckoutRes. Errors: 400 invalid body / amount,
// 400 currency_not_supported (payCurrency is in the registry but not enabled yet, e.g. INR), 404 unknown code or shop,
// 409 invoice_paid / invoice_expired / invoice_cancelled / merchant_not_live / payment_in_progress, 502 stripe_error,
// 503 stripe_not_configured / bnb_not_configured / ausd_not_configured.

import { CheckoutReq, getCurrency, isCurrency } from "@rove/shared";
import { getWebDeps } from "../_lib/deps";
import { HttpError, json, route } from "../_lib/http";
import { runCheckout } from "./checkout";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON.");
  }
  // A currency the registry knows but Rove doesn't settle in yet gets a readable answer instead of a schema error.
  const pay = (raw as { payCurrency?: unknown } | null)?.payCurrency;
  const planned = typeof pay === "string" ? getCurrency(pay) : undefined;
  if (planned && !isCurrency(planned.code)) {
    throw new HttpError(400, "currency_not_supported", `Paying in ${planned.code} isn't available yet. Pick another currency.`);
  }
  const body = CheckoutReq.parse(raw);
  return json(await runCheckout(getWebDeps(), body));
});
