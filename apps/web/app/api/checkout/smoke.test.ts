// Live smoke against the Stripe sandbox: skipped unless STRIPE_SECRET_KEY is a test key (sk_test_…).
//   cd apps/web && npx tsx --env-file=../../.env --test app/api/checkout/smoke.test.ts
// Real PaymentIntents through POST /api/checkout (PGlite DB, mock settlement), confirmed with pm_card_visa, then a
// self-signed payment_intent.succeeded through the webhook route so the real `expand: ["latest_charge"]` shape is used.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Stripe from "stripe";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money } from "@rove/shared";
import { setWebDepsForTests } from "../_lib/deps";
import { TEST_WEB_CONFIG, useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { POST as webhookPOST } from "../stripe/webhook/route";
import { POST } from "./route";
import { DEMO_CUSTOMER } from "@rove/shared/mocks";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const enabled = /^sk_test_.+/.test(key);
const WEBHOOK_SECRET = "whsec_rove_smoke_selfsigned";

describe("Stripe sandbox smoke (NI-B2 + NI-B3)", { skip: enabled ? false : "STRIPE_SECRET_KEY is not an sk_test_ key" }, () => {
  let deps: WebTestDeps;
  let stripe: Stripe;
  const realFetch = globalThis.fetch;
  const created: string[] = [];

  before(async () => {
    stripe = new Stripe(key);
    deps = await useWebTestDeps({
      db: await createTestDb({ demo: true }),
      stripe,
      config: { ...TEST_WEB_CONFIG, stripeWebhookSecret: WEBHOOK_SECRET },
    });
    // The worker nudge goes to worker.test: answer it locally. Stripe's SDK uses Node's http client, not fetch.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith("http://worker.test/") ? new Response(null, { status: 202 }) : realFetch(url, init)) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const id of created) {
      const pi = await stripe.paymentIntents.retrieve(id);
      if (pi.status === "requires_payment_method") await stripe.paymentIntents.cancel(id);
    }
    setWebDepsForTests(null);
    await deps?.db.close();
  });

  const checkout = async (code: string, payCurrency: "USD" | "SGD") => {
    const res = await POST(
      new Request("http://web.test/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: { source: "invoice", code }, method: "card", payCurrency }),
      }),
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return CheckoutRes.parse(body);
  };

  const newInvoice = () =>
    deps.db.createInvoice({
      merchantId: "ahseng",
      kind: "invoice",
      to: { phone: DEMO_CUSTOMER.phone, channel: "imessage" },
      lines: [{ menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") }, { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") }],
      total: money("12.50", "SGD"),
    });

  test("USD checkout → real PaymentIntent, reused on a repeat call, pm_card_visa succeeds, webhook authorizes", async () => {
    const inv = await newInvoice();
    const res = await checkout(inv.code, "USD");
    assert.deepEqual(res.charge, res.quote.usd);
    const p = (await deps.db.getPayment(res.paymentId))!;
    const piId = p.stripePaymentIntentId!;
    created.push(piId);

    const pi = await stripe.paymentIntents.retrieve(piId);
    assert.equal(pi.amount, Number(res.quote.usd.amount.replace(".", "")));
    assert.equal(pi.currency, "usd");
    assert.equal(pi.metadata.paymentId, res.paymentId);
    assert.equal(pi.metadata.merchantId, "ahseng");
    assert.equal(pi.client_secret, res.stripe?.clientSecret);

    const again = await checkout(inv.code, "USD");
    assert.equal(again.paymentId, res.paymentId);
    assert.equal(again.stripe?.clientSecret, res.stripe?.clientSecret);

    const confirmed = await stripe.paymentIntents.confirm(piId, { payment_method: "pm_card_visa", return_url: "https://example.com/rove-smoke" });
    assert.equal(confirmed.status, "succeeded");

    const payload = JSON.stringify({
      id: `evt_smoke_${res.paymentId}`,
      object: "event",
      api_version: null,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "payment_intent.succeeded",
      data: { object: confirmed },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const hook = await webhookPOST(new Request("http://web.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": header }, body: payload }), {});
    assert.equal(hook.status, 200);
    assert.equal(((await hook.json()) as { outcome: string }).outcome, "authorized");
    const after = (await deps.db.getPayment(res.paymentId))!;
    assert.equal(after.status, "authorized");
    assert.equal(after.method, "card");
  });

  test("SGD checkout → PaymentIntent in SGD for the invoice total", async () => {
    const res = await checkout((await newInvoice()).code, "SGD");
    const piId = (await deps.db.getPayment(res.paymentId))!.stripePaymentIntentId!;
    created.push(piId);
    const pi = await stripe.paymentIntents.retrieve(piId);
    assert.equal(pi.currency, "sgd");
    assert.equal(pi.amount, 1250);
  });
});
