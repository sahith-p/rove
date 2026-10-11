// Corridors Phase B (docs/specs/corridors.md §7): any enabled payer currency checks out, charged quote.pay in that
// currency, and the route (from, pay, sendMax) is stored for the worker.
//
// createTestDb({ demo: true, eurDemo: true }): ahseng (SGD) and cafe-berlin (EUR: Flat white 3.80, Croissant 2.50,
// Apfelstrudel 4.20, Pretzel 1.90). Mock settlement: 1.2900 SGD and 0.9259 EUR per USD, 1% SendMax headroom.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money, type InvoiceLine, type Recipient } from "@rove/shared";
import { setWebDepsForTests } from "../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { createFakeStripe, type FakeStripe } from "../stripe/fake-stripe";
import { POST } from "./route";
import { payerCurrency } from "./target";

const DE_PAYER: Recipient = { phone: "+4915112345678", channel: "whatsapp" };
const LINES: InvoiceLine[] = [
  { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
  { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
];

let deps: WebTestDeps;
let fake: FakeStripe;

beforeEach(async () => {
  fake = createFakeStripe();
  deps = await useWebTestDeps({ db: await createTestDb({ demo: true, eurDemo: true }), stripe: fake.client });
});
afterEach(async () => {
  setWebDepsForTests(null);
  await deps.db.close();
});

async function checkout(body: unknown) {
  const res = await POST(
    new Request("http://web.test/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    {},
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function ok(body: unknown) {
  const r = await checkout(body);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return CheckoutRes.parse(r.body);
}

const ahsengInvoice = (to: Recipient | null = null) =>
  deps.db.createInvoice({ merchantId: "ahseng", kind: to ? "invoice" : "one_time_qr", to, lines: LINES, total: money("12.50", "SGD") });
const byCode = (code: string, extra: Record<string, unknown> = {}) => ({ target: { source: "invoice", code }, method: "card", ...extra });
const cafe = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  target: { source: "fixed_qr", merchantId: "cafe-berlin", ...target },
  method: "card",
  ...extra,
});

describe("checkout · EUR payer at an SGD shop (EUR → RLUSD → XSGD)", () => {
  test("charge = quote.pay in EUR, PaymentIntent in eur, route stored on the payment", async () => {
    const inv = await ahsengInvoice();
    const res = await ok(byCode(inv.code, { payCurrency: "EUR" }));
    assert.deepEqual(res.local, money("12.50", "SGD"));
    assert.deepEqual(res.charge, money("8.98", "EUR"));
    assert.deepEqual(res.quote.pay, money("8.98", "EUR"));
    assert.equal(res.quote.sendMax, "9.07");
    assert.equal(res.quote.rate, "1.3932"); // S$ per €1: what the pay page shows ("€8.98 · S$12.50 at 1.3932")
    assert.deepEqual(res.quote.usd, money("9.69", "USD")); // the USD route stays filled
    const { params } = fake.calls.create[0]!;
    assert.deepEqual([params.amount, params.currency], [898, "eur"]);

    const p = (await deps.db.getPayment(res.paymentId))!;
    assert.deepEqual(p.charge, money("8.98", "EUR"));
    assert.deepEqual(p.quote?.pay, money("8.98", "EUR"));
    assert.equal(p.quote?.sendMax, "9.07");
  });

  test("no toggle: a +49 payer phone → EUR; the EUR payment is reused, a USD toggle is a separate one", async () => {
    const inv = await ahsengInvoice(DE_PAYER);
    const a = await ok(byCode(inv.code));
    assert.equal(a.charge?.currency, "EUR");
    const b = await ok(byCode(inv.code, { payCurrency: "EUR" }));
    assert.equal(b.paymentId, a.paymentId);
    assert.deepEqual(b.quote, a.quote); // pay + sendMax come back from the DB unchanged
    const usd = await ok(byCode(inv.code, { payCurrency: "USD" }));
    assert.notEqual(usd.paymentId, a.paymentId);
    assert.deepEqual(usd.charge, money("9.69", "USD"));
    assert.equal(fake.calls.create.length, 2);
  });
});

describe("checkout · the EUR shop cafe-berlin", () => {
  test("USD payer: fixed-QR basket priced from the EUR menu, charged quote.pay in USD", async () => {
    const res = await ok(
      cafe({ items: [{ menuItemId: "item_cb_flat_white", qty: 2 }, { menuItemId: "item_cb_croissant", qty: 1 }] }, { payCurrency: "USD" }),
    );
    assert.deepEqual(res.local, money("10.10", "EUR"));
    assert.deepEqual(res.charge, money("10.91", "USD"));
    assert.deepEqual(res.quote.pay, res.charge);
    assert.deepEqual([fake.calls.create[0]!.params.amount, fake.calls.create[0]!.params.currency], [1091, "usd"]);
  });

  test("EUR payer at an EUR shop: no conversion, charge = the total, rate 1", async () => {
    const res = await ok(cafe({ amount: "4.20" }, { payerPhone: DE_PAYER.phone }));
    assert.deepEqual(res.charge, money("4.20", "EUR"));
    assert.equal(res.quote.rate, "1.0000");
    assert.equal(res.quote.sendMax, "4.20");
  });

  test("SGD payer at an EUR shop (XSGD → RLUSD → EUR)", async () => {
    const res = await ok(cafe({ amount: "4.20" }, { payCurrency: "SGD" }));
    assert.equal(res.charge?.currency, "SGD");
    assert.deepEqual(res.quote.pay, res.charge);
    assert.equal(fake.calls.create[0]!.params.currency, "sgd");
  });

  test("the fixed-QR cap is in the shop's currency: €350", async () => {
    assert.deepEqual((await ok(cafe({ amount: "350.00" }))).local, money("350.00", "EUR"));
    const r = await checkout(cafe({ amount: "350.01" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "amount_over_limit");
    assert.match(r.body.message, /€350\.00/);
  });
});

describe("checkout · currencies that aren't enabled", () => {
  test("a planned registry currency → 400 currency_not_supported; an unknown code → invalid_body", async () => {
    const inv = await ahsengInvoice();
    const planned = await checkout(byCode(inv.code, { payCurrency: "INR" }));
    assert.deepEqual([planned.status, planned.body.error], [400, "currency_not_supported"]);
    assert.match(planned.body.message, /INR/);
    const unknown = await checkout(byCode(inv.code, { payCurrency: "JPY" }));
    assert.deepEqual([unknown.status, unknown.body.error], [400, "invalid_body"]);
    assert.equal(fake.calls.create.length, 0);
  });

  test("payerCurrency: a planned phone country (+91) falls back to USD; stablecoin lanes stay USD", () => {
    assert.equal(payerCurrency({ method: "card" }, { phone: "+919876543210", channel: "whatsapp" }), "USD");
    assert.equal(payerCurrency({ method: "card" }, DE_PAYER), "EUR");
    assert.equal(payerCurrency({ method: "bnb", payCurrency: "EUR" }, DE_PAYER), "USD");
  });
});
