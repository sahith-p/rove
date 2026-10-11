// POST /api/ausd/authorize + the ausd branch of POST /api/checkout, against PGlite, the mock settlement engine and a fake
// Base Sepolia reader. Mock rate 1.2900 SGD per USD: S$12.50 → US$9.69 → 9_690_000 AUSD base units.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PrivateKeyAccount } from "viem/accounts";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money, newId, PaymentStatusRes, type InvoiceLine } from "@rove/shared";
import { ausdNonce, expectedAuthorization, setAusdDepsForTests, type TransferWithAuthorization } from "../../_lib/ausd";
import { signAuthorization, TEST_AUSD_CONFIG, testPayer, useAusdTestDeps, type FakeAusdChain } from "../../_lib/ausd-testing";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { POST as checkoutPOST } from "../../checkout/route";
import { authorizeAusd } from "./authorize";
import { POST } from "./route";

const LINES: InvoiceLine[] = [
  { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
  { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
];

let deps: WebTestDeps;
let chain: FakeAusdChain;
let payer: PrivateKeyAccount;

beforeEach(async () => {
  deps = await useWebTestDeps({ db: await createTestDb({ demo: true }) });
  chain = useAusdTestDeps().chain;
  payer = testPayer();
  chain.fund(payer.address, 100_000_000n);
});
afterEach(async () => {
  setWebDepsForTests(null);
  setAusdDepsForTests(null);
  await deps.db.close();
});

const post = (handler: typeof POST, url: string, body: unknown) =>
  handler(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {});

async function checkoutAusd(code: string) {
  const res = await post(checkoutPOST, "http://web.test/api/checkout", { target: { source: "invoice", code }, method: "ausd" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return CheckoutRes.parse(body);
}

const invoice = () => deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: money("12.50", "SGD") });

/** The message the page signs, straight from CheckoutRes.ausd. */
function messageFrom(res: ReturnType<typeof CheckoutRes.parse>, from = payer.address): TransferWithAuthorization {
  const a = res.ausd!.authorization;
  return { from, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` };
}

async function authorize(body: unknown) {
  const res = await post(POST, "http://web.test/api/ausd/authorize", body);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function expectError(body: unknown, status: number, code: string) {
  const r = await authorize(body);
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.error, code);
  assert.equal(typeof r.body.message, "string");
}

describe("POST /api/checkout · method ausd", () => {
  test("creates a created ausd payment charged in USD and returns the authorization to sign", async () => {
    const inv = await invoice();
    const res = await checkoutAusd(inv.code);
    assert.deepEqual(res.charge, money("9.69", "USD"));
    assert.equal(res.ausd!.amount, "9.69");
    assert.equal(res.ausd!.authorization.value, "9690000");
    assert.equal(res.ausd!.authorization.nonce, ausdNonce(res.paymentId));
    assert.equal(res.ausd!.domain.name, "Agora Dollar");
    const p = await deps.db.getPayment(res.paymentId);
    assert.deepEqual([p?.method, p?.status, p?.invoiceId], ["ausd", "created", inv.id]);
    assert.deepEqual(p?.charge, money("9.69", "USD"));
  });

  test("an unsigned payment for the same invoice is handed back; a signed one in flight → 409", async () => {
    const inv = await invoice();
    const a = await checkoutAusd(inv.code);
    const b = await checkoutAusd(inv.code);
    assert.equal(b.paymentId, a.paymentId);
    assert.deepEqual(b.ausd, a.ausd);

    const signature = await signAuthorization(payer, TEST_AUSD_CONFIG, messageFrom(a));
    assert.equal((await authorize({ paymentId: a.paymentId, from: payer.address, signature })).status, 200);
    const r = await post(checkoutPOST, "http://web.test/api/checkout", { target: { source: "invoice", code: inv.code }, method: "ausd" });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, "payment_in_progress");
  });

  test("not configured (no AUSD_PAY_TO) → 503 ausd_not_configured, nothing written", async () => {
    setAusdDepsForTests(null);
    const saved = process.env.AUSD_PAY_TO;
    delete process.env.AUSD_PAY_TO;
    try {
      const inv = await invoice();
      const r = await post(checkoutPOST, "http://web.test/api/checkout", { target: { source: "invoice", code: inv.code }, method: "ausd" });
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as { error: string }).error, "ausd_not_configured");
      assert.deepEqual(await deps.db.listPayments("ahseng"), []);
    } finally {
      if (saved !== undefined) process.env.AUSD_PAY_TO = saved;
      setAusdDepsForTests(null);
    }
  });
});

describe("POST /api/ausd/authorize", () => {
  async function signed() {
    const res = await checkoutAusd((await invoice()).code);
    const signature = await signAuthorization(payer, TEST_AUSD_CONFIG, messageFrom(res));
    return { res, signature, config: TEST_AUSD_CONFIG };
  }

  test("created + valid signature → stored, PaymentStatusRes (status created, method ausd)", async () => {
    const { res, signature } = await signed();
    const r = await authorize({ paymentId: res.paymentId, from: payer.address.toLowerCase(), signature });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const status = PaymentStatusRes.parse(r.body);
    assert.deepEqual([status.status, status.method, status.merchantName], ["created", "ausd", "Ah Seng Chicken Rice"]);
    assert.deepEqual(status.charge, money("9.69", "USD"));

    const relay = await deps.db.getAusdRelay(res.paymentId);
    assert.equal(relay?.authorization.from, payer.address); // checksummed
    assert.equal(relay?.authorization.value, "9690000");
    assert.equal(relay?.authorization.nonce, ausdNonce(res.paymentId));
    assert.equal(relay?.authorization.signature, signature.toLowerCase());
  });

  test("replay: the same authorization again is idempotent; a different one is 409 already_authorized", async () => {
    const { res, signature, config } = await signed();
    assert.equal((await authorize({ paymentId: res.paymentId, from: payer.address, signature })).status, 200);
    assert.equal((await authorize({ paymentId: res.paymentId, from: payer.address, signature })).status, 200);

    const other = testPayer();
    chain.fund(other.address, 100_000_000n);
    const otherSig = await signAuthorization(other, config, messageFrom(res, other.address));
    await expectError({ paymentId: res.paymentId, from: other.address, signature: otherSig }, 409, "already_authorized");
  });

  test("wrong amount, recipient or payer → 400 invalid_signature", async () => {
    const { res, config } = await signed();
    const m = messageFrom(res);
    const wrongValue = await signAuthorization(payer, config, { ...m, value: m.value - 1n });
    await expectError({ paymentId: res.paymentId, from: payer.address, signature: wrongValue }, 400, "invalid_signature");
    const wrongTo = await signAuthorization(payer, config, { ...m, to: payer.address });
    await expectError({ paymentId: res.paymentId, from: payer.address, signature: wrongTo }, 400, "invalid_signature");
    const good = await signAuthorization(payer, config, m);
    await expectError({ paymentId: res.paymentId, from: testPayer().address, signature: good }, 400, "invalid_signature");
    assert.equal(await deps.db.getAusdRelay(res.paymentId), null);
  });

  test("wrong method or status → 409; unknown payment → 404; malformed input → 400", async () => {
    const { res, signature } = await signed();
    const card = await deps.db.insertPayment({
      id: newId("pay"),
      merchantId: "ahseng",
      source: "fixed_qr",
      invoiceId: null,
      lines: [],
      local: money("5.00", "SGD"),
      quote: res.quote,
      charge: money("3.88", "USD"),
      method: "card",
      payer: null,
    });
    await expectError({ paymentId: card.id, from: payer.address, signature }, 409, "wrong_method");

    await deps.db.transitionPayment(res.paymentId, ["created"], "failed", { failureReason: "test" });
    await expectError({ paymentId: res.paymentId, from: payer.address, signature }, 409, "payment_not_open");

    await expectError({ paymentId: "pay_nope", from: payer.address, signature }, 404, "payment_not_found");
    await expectError({ paymentId: res.paymentId, from: "0x123", signature }, 400, "invalid_address");
    await expectError({ paymentId: res.paymentId, from: payer.address, signature: "0xabc" }, 400, "invalid_signature_format");
    await expectError({ paymentId: res.paymentId }, 400, "invalid_body");
  });

  test("quote long expired → 410; not enough AUSD → 422; nonce already used on-chain → 409", async () => {
    const { res, signature } = await signed();
    const body = { paymentId: res.paymentId, from: payer.address, signature };
    const late = Date.parse(res.quote.expiresAt) + 11 * 60_000;
    await assert.rejects(authorizeAusd(deps, { config: TEST_AUSD_CONFIG, chain }, body, late), {
      status: 410,
      code: "quote_expired",
    });

    const poor = testPayer();
    const poorSig = await signAuthorization(poor, TEST_AUSD_CONFIG, messageFrom(res, poor.address));
    await expectError({ paymentId: res.paymentId, from: poor.address, signature: poorSig }, 422, "insufficient_funds");

    chain.markUsed(payer.address, ausdNonce(res.paymentId));
    await expectError(body, 409, "authorization_used");
    assert.equal(await deps.db.getAusdRelay(res.paymentId), null);
  });

  test("the invoice was paid by another payment meanwhile → 409 invoice_paid", async () => {
    const { res, signature } = await signed();
    const p = (await deps.db.getPayment(res.paymentId))!;
    const other = await deps.db.insertPayment({
      id: newId("pay"),
      merchantId: "ahseng",
      source: "invoice",
      invoiceId: p.invoiceId,
      lines: p.lines,
      local: p.local,
      quote: p.quote,
      charge: money("12.50", "SGD"),
      method: "card",
      payer: null,
    });
    await deps.db.markInvoicePaid(p.invoiceId!, other.id);
    await expectError({ paymentId: res.paymentId, from: payer.address, signature }, 409, "invoice_paid");
  });

  test("expectedAuthorization rebuilds the checkout message from the DB", async () => {
    const { res, config } = await signed();
    const p = (await deps.db.getPayment(res.paymentId))!;
    assert.deepEqual(expectedAuthorization(p, payer.address, config), messageFrom(res));
  });
});
