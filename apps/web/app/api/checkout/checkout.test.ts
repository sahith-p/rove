import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money, type InvoiceLine, type Recipient } from "@rove/shared";
import { setAusdDepsForTests } from "../_lib/ausd";
import { setWebDepsForTests } from "../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { createFakeStripe, stripeError, type FakeStripe } from "../stripe/fake-stripe";
import { POST } from "./route";
import { payerCurrency } from "./target";
import { DEMO_CUSTOMER } from "@rove/shared/mocks";

// createTestDb({ demo: true }): live merchant "ahseng" with item_chicken_rice 5.50, item_roasted 6.00, item_egg 1.00,
// item_barley 1.50 (SGD). Mock settlement: 1.2900 SGD per USD, so S$12.50 → US$9.69.

const MAYA: Recipient = { phone: DEMO_CUSTOMER.phone, channel: "imessage" };
const SG_PAYER: Recipient = { phone: "+6591234567", channel: "whatsapp" };
const LINES: InvoiceLine[] = [
  { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
  { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
];

let deps: WebTestDeps;
let fake: FakeStripe;

beforeEach(async () => {
  fake = createFakeStripe();
  deps = await useWebTestDeps({ db: await createTestDb({ demo: true }), stripe: fake.client });
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

async function expectError(body: unknown, status: number, code: string) {
  const r = await checkout(body);
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.error, code);
  assert.equal(typeof r.body.message, "string");
}

function invoice(opts: { to?: Recipient | null; expiresAt?: string; kind?: "invoice" | "one_time_qr" | "pay_request" } = {}) {
  return deps.db.createInvoice({
    merchantId: "ahseng",
    kind: opts.kind ?? "invoice",
    to: opts.to === undefined ? MAYA : opts.to,
    lines: LINES,
    total: money("12.50", "SGD"),
    expiresAt: opts.expiresAt,
  });
}

const byCode = (code: string, extra: Record<string, unknown> = {}) => ({ target: { source: "invoice", code }, method: "card", ...extra });
const shop = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  target: { source: "fixed_qr", merchantId: "ahseng", ...target },
  method: "card",
  ...extra,
});

describe("POST /api/checkout · invoice codes", () => {
  test("USD payer: charge = quote.usd, PaymentIntent in USD, payment row created with its PI", async () => {
    const inv = await invoice();
    const res = await ok(byCode(inv.code, { payCurrency: "USD" }));

    assert.deepEqual(res.local, money("12.50", "SGD"));
    assert.deepEqual(res.quote.usd, money("9.69", "USD"));
    assert.deepEqual(res.charge, res.quote.usd);
    assert.equal(fake.calls.create.length, 1);
    const { params, options } = fake.calls.create[0]!;
    assert.equal(params.amount, 969);
    assert.equal(params.currency, "usd");
    assert.deepEqual(params.automatic_payment_methods, { enabled: true });
    assert.deepEqual(params.metadata, { paymentId: res.paymentId, merchantId: "ahseng" });
    assert.equal(options?.idempotencyKey, res.paymentId);
    const pi = [...fake.intents.values()][0]!;
    assert.equal(res.stripe?.clientSecret, pi.client_secret);

    const p = await deps.db.getPayment(res.paymentId);
    assert.ok(p);
    assert.equal(p.status, "created");
    assert.equal(p.method, "card");
    assert.equal(p.source, "invoice");
    assert.equal(p.invoiceId, inv.id);
    assert.equal(p.stripePaymentIntentId, pi.id);
    assert.deepEqual(p.charge, money("9.69", "USD"));
    assert.deepEqual(p.local, money("12.50", "SGD"));
    assert.deepEqual(p.lines, LINES);
    assert.deepEqual(p.payer, MAYA);
  });

  test("SGD payer: charge = the total itself, PaymentIntent in SGD", async () => {
    const inv = await invoice();
    const res = await ok(byCode(inv.code, { payCurrency: "SGD" }));
    assert.deepEqual(res.charge, money("12.50", "SGD"));
    assert.deepEqual(res.quote.local, money("12.50", "SGD"));
    assert.equal(fake.calls.create[0]!.params.amount, 1250);
    assert.equal(fake.calls.create[0]!.params.currency, "sgd");
    assert.deepEqual((await deps.db.getPayment(res.paymentId))?.charge, money("12.50", "SGD"));
  });

  test("no payCurrency: the payer's phone country decides (+65 → SGD, else USD), no payer → USD", async () => {
    assert.equal((await ok(byCode((await invoice({ to: SG_PAYER })).code))).charge?.currency, "SGD");
    assert.equal((await ok(byCode((await invoice({ to: MAYA })).code))).charge?.currency, "USD");
    assert.equal((await ok(byCode((await invoice({ to: null, kind: "one_time_qr" })).code))).charge?.currency, "USD");
    // payerPhone stands in when the code has no recipient
    const qr = await invoice({ to: null, kind: "one_time_qr" });
    const res = await ok(byCode(qr.code, { payerPhone: SG_PAYER.phone }));
    assert.equal(res.charge?.currency, "SGD");
    assert.equal((await deps.db.getPayment(res.paymentId))?.payer?.phone, SG_PAYER.phone);
    // an explicit toggle beats the phone
    assert.equal((await ok(byCode((await invoice({ to: SG_PAYER })).code, { payCurrency: "USD" }))).charge?.currency, "USD");
  });

  test("payerCurrency: stablecoin lanes are always USD", () => {
    assert.equal(payerCurrency({ method: "bnb", payCurrency: "SGD" }, SG_PAYER), "USD");
    assert.equal(payerCurrency({ method: "ausd", payCurrency: "SGD" }, SG_PAYER), "USD");
    assert.equal(payerCurrency({ method: "card" }, SG_PAYER), "SGD");
    assert.equal(payerCurrency({ method: "card" }, null), "USD");
  });

  test("one_time_qr and pay_request codes pay the same way; source is the code's kind", async () => {
    for (const kind of ["one_time_qr", "pay_request"] as const) {
      const res = await ok(byCode((await invoice({ kind })).code));
      assert.equal((await deps.db.getPayment(res.paymentId))?.source, kind);
    }
  });

  test("codes are case-insensitive", async () => {
    const inv = await invoice();
    const res = await ok(byCode(inv.code.toLowerCase()));
    assert.equal((await deps.db.getPayment(res.paymentId))?.invoiceId, inv.id);
  });

  test("unknown → 404; expired / paid / cancelled → 409 with a readable code", async () => {
    await expectError(byCode("ZZZZZZ"), 404, "invoice_not_found");
    await expectError(byCode((await invoice({ expiresAt: new Date(Date.now() - 1000).toISOString() })).code), 409, "invoice_expired");
    const paid = await invoice();
    await deps.db.markInvoicePaid(paid.id, "pay_elsewhere");
    await expectError(byCode(paid.code), 409, "invoice_paid");
    const cancelled = await invoice();
    assert.ok(await deps.db.cancelInvoice("ahseng", cancelled.code));
    await expectError(byCode(cancelled.code), 409, "invoice_cancelled");
    assert.equal(fake.calls.create.length, 0);
  });

  test("an invoice whose payment is already authorized (not yet settled) → 409 invoice_paid", async () => {
    const inv = await invoice();
    const first = await ok(byCode(inv.code, { payCurrency: "USD" }));
    assert.ok(await deps.db.transitionPayment(first.paymentId, ["created"], "authorized", { method: "apple_pay" }));
    await expectError(byCode(inv.code, { payCurrency: "SGD" }), 409, "invoice_paid");
  });
});

describe("POST /api/checkout · fixed QR", () => {
  test("prices come from the DB: duplicates merged, client prices ignored", async () => {
    const res = await ok(
      shop({
        items: [
          { menuItemId: "item_chicken_rice", qty: 2, price: "0.01" },
          { menuItemId: "item_barley", qty: 1, unit: { amount: "0.01", currency: "SGD" } },
          { menuItemId: "item_chicken_rice", qty: 1 },
        ],
        amount: "0.01", // items win over a typed amount
      }),
    );
    assert.deepEqual(res.local, money("18.00", "SGD"));
    const p = await deps.db.getPayment(res.paymentId);
    assert.ok(p);
    assert.equal(p.source, "fixed_qr");
    assert.equal(p.invoiceId, null);
    assert.deepEqual(p.lines, [
      { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 3, unit: money("5.50", "SGD") },
      { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
    ]);
  });

  test("a typed amount: no lines; payerPhone +65 → SGD charge", async () => {
    const res = await ok(shop({ amount: "6.5" }, { payerPhone: SG_PAYER.phone }));
    assert.deepEqual(res.local, money("6.50", "SGD"));
    assert.deepEqual(res.charge, money("6.50", "SGD"));
    const p = await deps.db.getPayment(res.paymentId);
    assert.deepEqual(p?.lines, []);
    assert.equal(p?.payer?.phone, SG_PAYER.phone);
  });

  test("0 < total ≤ S$500", async () => {
    assert.deepEqual((await ok(shop({ amount: "500.00" }))).local, money("500.00", "SGD"));
    await expectError(shop({ amount: "500.01" }), 400, "amount_over_limit");
    await expectError(shop({ items: [{ menuItemId: "item_chicken_rice", qty: 91 }] }), 400, "amount_over_limit"); // S$500.50
    await expectError(shop({ amount: "0.00" }), 400, "invalid_amount");
    await expectError(shop({ amount: "1.234" }), 400, "invalid_amount");
    await expectError(shop({}), 400, "amount_required");
    await expectError(shop({ amount: "-5" }), 400, "invalid_body");
  });

  test("unknown or inactive menu items → 400", async () => {
    await expectError(shop({ items: [{ menuItemId: "item_nope", qty: 1 }] }), 400, "menu_item_unavailable");
    const menu = await deps.db.listMenu("ahseng");
    await deps.db.replaceMenu(
      "ahseng",
      menu.filter((m) => m.id !== "item_egg").map((m) => ({ id: m.id, name: m.name, price: m.price })),
    );
    await expectError(shop({ items: [{ menuItemId: "item_egg", qty: 1 }] }), 400, "menu_item_unavailable");
  });

  test("unknown shop → 404, draft shop → 409", async () => {
    await expectError({ target: { source: "fixed_qr", merchantId: "nope", amount: "5.00" }, method: "card" }, 404, "merchant_not_found");
    await deps.db.upsertDraftMerchant({ id: "draftshop", name: "Draft Shop", phone: "+6590000001", channel: "whatsapp" });
    await expectError({ target: { source: "fixed_qr", merchantId: "draftshop", amount: "5.00" }, method: "card" }, 409, "merchant_not_live");
  });
});

describe("POST /api/checkout · reuse", () => {
  test("repeated calls hand back the same payment and client secret", async () => {
    const inv = await invoice();
    const a = await ok(byCode(inv.code, { payCurrency: "USD" }));
    const b = await ok(byCode(inv.code, { payCurrency: "USD" }));
    assert.equal(b.paymentId, a.paymentId);
    assert.equal(b.stripe?.clientSecret, a.stripe?.clientSecret);
    assert.deepEqual(b.charge, a.charge);
    assert.equal(b.quote.expiresAt, a.quote.expiresAt);
    assert.equal(fake.calls.create.length, 1);
  });

  test("currency toggle USD → SGD → USD: one payment per currency, the USD one reused", async () => {
    const inv = await invoice();
    const usd = await ok(byCode(inv.code, { payCurrency: "USD" }));
    const sgd = await ok(byCode(inv.code, { payCurrency: "SGD" }));
    const usd2 = await ok(byCode(inv.code, { payCurrency: "USD" }));
    const sgd2 = await ok(byCode(inv.code, { payCurrency: "SGD" }));
    assert.notEqual(sgd.paymentId, usd.paymentId);
    assert.equal(usd2.paymentId, usd.paymentId);
    assert.equal(sgd2.paymentId, sgd.paymentId);
    assert.equal(fake.calls.create.length, 2);
    assert.equal(fake.calls.cancel.length, 0);
  });

  test("an expired quote is not reused: new payment, the old PaymentIntent cancelled", async () => {
    const inv = await invoice();
    const old = await ok(byCode(inv.code, { payCurrency: "USD" }));
    await deps.db.transitionPayment(old.paymentId, ["created"], "created", {
      quote: { ...old.quote, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const fresh = await ok(byCode(inv.code, { payCurrency: "USD" }));
    assert.notEqual(fresh.paymentId, old.paymentId);
    const oldPi = (await deps.db.getPayment(old.paymentId))!.stripePaymentIntentId!;
    assert.deepEqual(fake.calls.cancel, [oldPi]);
    assert.equal(fake.intent(oldPi).status, "canceled");
  });

  test("a quote about to expire is not handed out again", async () => {
    const inv = await invoice();
    const old = await ok(byCode(inv.code, { payCurrency: "USD" }));
    await deps.db.transitionPayment(old.paymentId, ["created"], "created", {
      quote: { ...old.quote, expiresAt: new Date(Date.now() + 2000).toISOString() },
    });
    assert.notEqual((await ok(byCode(inv.code, { payCurrency: "USD" }))).paymentId, old.paymentId);
  });

  test("invoice whose PaymentIntent already succeeded (webhook pending) → 409 payment_in_progress", async () => {
    const inv = await invoice();
    const a = await ok(byCode(inv.code, { payCurrency: "USD" }));
    fake.succeed((await deps.db.getPayment(a.paymentId))!.stripePaymentIntentId!);
    await expectError(byCode(inv.code, { payCurrency: "USD" }), 409, "payment_in_progress");
  });

  test("fixed QR: same basket (any order) + same phone reused; another phone or basket is a new payment", async () => {
    const items = [
      { menuItemId: "item_chicken_rice", qty: 1 },
      { menuItemId: "item_egg", qty: 2 },
    ];
    const a = await ok(shop({ items }, { payerPhone: MAYA.phone, payCurrency: "USD" }));
    const b = await ok(shop({ items: [...items].reverse() }, { payerPhone: MAYA.phone, payCurrency: "USD" }));
    assert.equal(b.paymentId, a.paymentId);
    assert.equal(b.stripe?.clientSecret, a.stripe?.clientSecret);
    const otherPhone = await ok(shop({ items }, { payerPhone: SG_PAYER.phone, payCurrency: "USD" }));
    const noPhone = await ok(shop({ items }, { payCurrency: "USD" }));
    const otherBasket = await ok(shop({ items: [{ menuItemId: "item_egg", qty: 2 }] }, { payerPhone: MAYA.phone, payCurrency: "USD" }));
    const ids = new Set([a.paymentId, otherPhone.paymentId, noPhone.paymentId, otherBasket.paymentId]);
    assert.equal(ids.size, 4);
    // same typed amount reused too
    const amt = await ok(shop({ amount: "7.00" }, { payCurrency: "SGD" }));
    assert.equal((await ok(shop({ amount: "7" }, { payCurrency: "SGD" }))).paymentId, amt.paymentId);
  });

  test("fixed QR: a basket that was just paid isn't reused; buying it again is a new payment", async () => {
    const a = await ok(shop({ amount: "4.00" }, { payCurrency: "USD" }));
    fake.succeed((await deps.db.getPayment(a.paymentId))!.stripePaymentIntentId!);
    const b = await ok(shop({ amount: "4.00" }, { payCurrency: "USD" }));
    assert.notEqual(b.paymentId, a.paymentId);
  });
});

describe("POST /api/checkout · lanes and failures", () => {
  test("unconfigured ausd answers 503 from its own branch, after the target is validated (bnb: bnb.test.ts)", async () => {
    const inv = await invoice();
    // The AUSD lane itself is tested in ../ausd/authorize/authorize.test.ts; without AUSD_PAY_TO it is off.
    const savedPayTo = process.env.AUSD_PAY_TO;
    delete process.env.AUSD_PAY_TO;
    setAusdDepsForTests(null);
    try {
      await expectError(byCode(inv.code, { method: "ausd" }), 503, "ausd_not_configured");
    } finally {
      if (savedPayTo !== undefined) process.env.AUSD_PAY_TO = savedPayTo;
      setAusdDepsForTests(null);
    }
    await expectError(byCode("ZZZZZZ", { method: "bnb" }), 404, "invoice_not_found");
    assert.equal(fake.calls.create.length, 0);
  });

  test("Stripe not configured → 503, nothing written", async () => {
    setWebDepsForTests({ ...deps, stripe: null });
    const inv = await invoice();
    await expectError(byCode(inv.code), 503, "stripe_not_configured");
    assert.deepEqual(await deps.db.listPayments("ahseng"), []);
  });

  test("Stripe errors: amount_too_small → 400, anything else → 502; no payment row either way", async () => {
    const inv = await invoice();
    fake.failNext.create = stripeError("StripeInvalidRequestError", "amount_too_small", "Amount must be at least $0.50 usd");
    await expectError(byCode(inv.code), 400, "amount_too_small");
    fake.failNext.create = stripeError("StripeConnectionError", "", "socket hang up");
    await expectError(byCode(inv.code), 502, "stripe_error");
    assert.deepEqual(await deps.db.listPayments("ahseng"), []);
  });

  test("invalid bodies → 400", async () => {
    const r = await checkout({ target: { source: "invoice" }, method: "card" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_body");
    await expectError(byCode("K7Q2MX", { payCurrency: "JPY" }), 400, "invalid_body"); // not in the currency registry
  });
});
