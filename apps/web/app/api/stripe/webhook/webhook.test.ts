import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Db } from "@rove/db";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money, type Currency, type InvoiceLine } from "@rove/shared";
import { POST as checkoutPOST } from "../../checkout/route";
import { setWebDepsForTests } from "../../_lib/deps";
import { TEST_INTERNAL_SECRET, TEST_WEB_CONFIG, useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { createFakeStripe, FAKE_WEBHOOK_SECRET, stripeError, type FakeStripe } from "../fake-stripe";
import { DUPLICATE_INVOICE_REASON } from "./handle";
import { POST } from "./route";
import { DEMO_CUSTOMER } from "@rove/shared/mocks";

const LINES: InvoiceLine[] = [{ menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") }];

let deps: WebTestDeps;
let fake: FakeStripe;
let nudges: { url: string; body: unknown; auth: string | null }[];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  fake = createFakeStripe();
  deps = await useWebTestDeps({
    db: await createTestDb({ demo: true }),
    stripe: fake.client,
    config: { ...TEST_WEB_CONFIG, stripeWebhookSecret: FAKE_WEBHOOK_SECRET },
  });
  nudges = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    nudges.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  setWebDepsForTests(null);
  await deps.db.close();
});

/** A real checkout through the route: invoice code → created payment with a fake PaymentIntent. */
async function startPayment(code: string, payCurrency: Currency = "USD") {
  const res = await checkoutPOST(
    new Request("http://web.test/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { source: "invoice", code }, method: "card", payCurrency }),
    }),
    {},
  );
  assert.equal(res.status, 200);
  const { paymentId } = CheckoutRes.parse(await res.json());
  const piId = (await deps.db.getPayment(paymentId))!.stripePaymentIntentId!;
  return { paymentId, piId };
}

async function newInvoice() {
  return deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", to: { phone: DEMO_CUSTOMER.phone, channel: "imessage" }, lines: LINES, total: money("11.00", "SGD") });
}

async function paidPayment(wallet: "apple_pay" | "google_pay" | null = null) {
  const p = await startPayment((await newInvoice()).code);
  fake.succeed(p.piId, wallet);
  return p;
}

async function send(payload: string, header: string | null) {
  const res = await POST(
    new Request("http://web.test/api/stripe/webhook", {
      method: "POST",
      headers: header === null ? {} : { "stripe-signature": header },
      body: payload,
    }),
    {},
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function deliver(type: string, object: object, eventId?: string) {
  const { payload, header } = fake.signedEvent(type, object, eventId);
  return send(payload, header);
}

const status = async (id: string) => (await deps.db.getPayment(id))!;

describe("POST /api/stripe/webhook · verification", () => {
  test("bad, missing or replayed-onto-another-body signatures → 400, and nothing is claimed", async () => {
    const { paymentId, piId } = await paidPayment();
    const evt = fake.signedEvent("payment_intent.succeeded", fake.intent(piId), "evt_sig1");
    const forged = fake.signedEvent("payment_intent.succeeded", fake.intent(piId), "evt_sig1", "whsec_someone_else");
    assert.equal((await send(forged.payload, forged.header)).body.error, "invalid_signature");
    assert.equal((await send(evt.payload, null)).body.error, "missing_signature");
    const other = fake.signedEvent("payment_intent.succeeded", { ...fake.intent(piId), amount: 1 }, "evt_sig1");
    const swapped = await send(other.payload, evt.header);
    assert.equal(swapped.status, 400);
    assert.equal(swapped.body.error, "invalid_signature");
    assert.equal((await status(paymentId)).status, "created");

    // the genuine delivery of the same event id still goes through: the failures didn't claim it
    const res = await send(evt.payload, evt.header);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "authorized");
  });

  test("no webhook secret configured → 503 so Stripe keeps retrying", async () => {
    setWebDepsForTests({ ...deps, config: { ...deps.config, stripeWebhookSecret: null } });
    const { piId } = await paidPayment();
    const res = await deliver("payment_intent.succeeded", fake.intent(piId));
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "stripe_not_configured");
  });
});

describe("POST /api/stripe/webhook · payment_intent.succeeded", () => {
  test("created → authorized as card, worker nudged with the internal secret", async () => {
    const { paymentId, piId } = await paidPayment();
    const res = await deliver("payment_intent.succeeded", fake.intent(piId));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, outcome: "authorized" });
    const p = await status(paymentId);
    assert.equal(p.status, "authorized");
    assert.equal(p.method, "card");
    assert.deepEqual(fake.calls.retrieve.at(-1), { id: piId, params: { expand: ["latest_charge"] } });
    assert.deepEqual(nudges, [{ url: "http://worker.test/internal/settle", body: { paymentId }, auth: `Bearer ${TEST_INTERNAL_SECRET}` }]);
  });

  test("Apple Pay is detected from the charge's wallet; other wallets record card", async () => {
    const apple = await paidPayment("apple_pay");
    await deliver("payment_intent.succeeded", fake.intent(apple.piId));
    assert.equal((await status(apple.paymentId)).method, "apple_pay");
    const google = await paidPayment("google_pay");
    await deliver("payment_intent.succeeded", fake.intent(google.piId));
    assert.equal((await status(google.paymentId)).method, "card");
  });

  test("the same event twice: authorized once, one nudge", async () => {
    const { paymentId, piId } = await paidPayment("apple_pay");
    const { payload, header } = fake.signedEvent("payment_intent.succeeded", fake.intent(piId), "evt_dup1");
    assert.equal((await send(payload, header)).body.outcome, "authorized");
    const after = await status(paymentId);
    const again = await send(payload, header);
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, "duplicate");
    assert.equal((await status(paymentId)).updatedAt, after.updatedAt);
    assert.equal(nudges.length, 1);
  });

  test("a different event for an already-authorized payment is a no-op", async () => {
    const { piId } = await paidPayment();
    await deliver("payment_intent.succeeded", fake.intent(piId));
    const res = await deliver("payment_intent.succeeded", fake.intent(piId));
    assert.equal(res.body.outcome, "already_processed");
    assert.equal(nudges.length, 1);
  });

  test("no metadata.paymentId → found by PaymentIntent id", async () => {
    const { paymentId, piId } = await paidPayment();
    const res = await deliver("payment_intent.succeeded", { ...fake.intent(piId), metadata: {} });
    assert.equal(res.body.outcome, "authorized");
    assert.equal((await status(paymentId)).status, "authorized");
  });

  test("unknown payment → 200, logged and ignored", async () => {
    const res = await deliver("payment_intent.succeeded", { id: "pi_unknown", object: "payment_intent", amount: 100, currency: "usd", metadata: { paymentId: "pay_nope" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "unknown_payment");
    assert.equal(nudges.length, 0);
  });

  test("a charge that doesn't match the payment's amount is not authorized", async () => {
    const { paymentId, piId } = await paidPayment();
    fake.intents.get(piId)!.amount = 1;
    const res = await deliver("payment_intent.succeeded", fake.intent(piId));
    assert.equal(res.body.outcome, "mismatch");
    assert.equal((await status(paymentId)).status, "created");
  });

  test("Stripe unreachable for the wallet lookup → still authorized, as card", async () => {
    const { paymentId, piId } = await paidPayment("apple_pay");
    fake.failNext.retrieve = stripeError("StripeConnectionError", "", "timeout");
    assert.equal((await deliver("payment_intent.succeeded", fake.intent(piId))).body.outcome, "authorized");
    assert.equal((await status(paymentId)).method, "card");
  });

  test("a crash after claim() doesn't strand the charge: Stripe's retry still authorizes", async () => {
    const { paymentId, piId } = await paidPayment();
    const db = deps.db;
    let blip = true;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === "transitionPayment" && blip) {
          return async () => {
            blip = false;
            throw new Error("connection reset");
          };
        }
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    setWebDepsForTests({ ...deps, db: flaky });
    const { payload, header } = fake.signedEvent("payment_intent.succeeded", fake.intent(piId), "evt_crash1");
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal((await send(payload, header)).status, 500);
    } finally {
      console.error = originalError;
    }
    assert.equal((await status(paymentId)).status, "created");
    const retry = await send(payload, header);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.outcome, "authorized");
    assert.equal((await status(paymentId)).status, "authorized");
  });
});

describe("POST /api/stripe/webhook · invoice paid twice (§7)", () => {
  async function twoPaymentsForOneInvoice() {
    const inv = await newInvoice();
    const first = await startPayment(inv.code, "USD");
    const second = await startPayment(inv.code, "SGD"); // e.g. two devices, or a toggle race
    assert.notEqual(first.paymentId, second.paymentId);
    fake.succeed(first.piId, "apple_pay");
    fake.succeed(second.piId, null);
    assert.equal((await deliver("payment_intent.succeeded", fake.intent(first.piId))).body.outcome, "authorized");
    return { first, second };
  }

  test("the second authorization is refunded in full, marked failed, payment.failed emitted", async () => {
    const { first, second } = await twoPaymentsForOneInvoice();
    const { payload, header } = fake.signedEvent("payment_intent.succeeded", fake.intent(second.piId), "evt_second");
    const res = await send(payload, header);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "refunded_duplicate");

    assert.deepEqual(
      fake.calls.refund.map((c) => [c.params, c.options]),
      [[{ payment_intent: second.piId }, { idempotencyKey: `dup:${second.paymentId}` }]],
    );
    const p = await status(second.paymentId);
    assert.equal(p.status, "failed");
    assert.equal((await status(first.paymentId)).status, "authorized");
    assert.deepEqual(deps.events, [{ type: "payment.failed", paymentId: second.paymentId, merchantId: "ahseng", reason: DUPLICATE_INVOICE_REASON }]);
    assert.deepEqual(nudges.map((n) => n.body), [{ paymentId: first.paymentId }]);

    // repeated delivery: nothing more refunded or emitted
    assert.equal((await send(payload, header)).body.outcome, "duplicate");
    assert.equal(fake.calls.refund.length, 1);
    assert.equal(deps.events.length, 1);
  });

  test("refund fails → 500 and the payment stays created; Stripe's retry refunds it once", async () => {
    const { second } = await twoPaymentsForOneInvoice();
    fake.failNext.refund = stripeError("StripeAPIError", "api_error", "Stripe is down");
    const { payload, header } = fake.signedEvent("payment_intent.succeeded", fake.intent(second.piId), "evt_refund_retry");
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal((await send(payload, header)).status, 500);
    } finally {
      console.error = originalError;
    }
    assert.equal((await status(second.paymentId)).status, "created");
    assert.equal(deps.events.length, 0);

    const retry = await send(payload, header);
    assert.equal(retry.body.outcome, "refunded_duplicate");
    assert.equal((await status(second.paymentId)).status, "failed");
    assert.equal(fake.refunds.size, 1);
    assert.equal(deps.events.length, 1);
  });
});

describe("POST /api/stripe/webhook · other events", () => {
  test("payment_intent.payment_failed is logged only; the payment stays created for a retry", async () => {
    const { paymentId, piId } = await startPayment((await newInvoice()).code);
    const res = await deliver("payment_intent.payment_failed", {
      ...fake.intent(piId),
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "logged");
    assert.equal((await status(paymentId)).status, "created");
    assert.equal(deps.events.length, 0);
  });

  test("anything else → 200 ignored", async () => {
    const res = await deliver("charge.refunded", { id: "ch_1", object: "charge" });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, "ignored");
  });
});
