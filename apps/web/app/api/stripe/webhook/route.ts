// POST /api/stripe/webhook: verify the signature on the raw body, payment_intent.succeeded → authorized → worker
// /internal/settle. Owner: Nithya · Task: NI-B3 · Spec: docs/specs/payments-stripe.md §2 · Logic: ./handle.ts
// Local: stripe listen --forward-to localhost:3000/api/stripe/webhook (puts the whsec_ in STRIPE_WEBHOOK_SECRET).

import { getWebDeps } from "../../_lib/deps";
import { route } from "../../_lib/http";
import { handleStripeWebhook } from "./handle";

export const runtime = "nodejs";

export const POST = route((req) => handleStripeWebhook(getWebDeps(), req));
