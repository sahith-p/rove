import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { money, PaymentStatusRes, type Payment } from "@rove/shared";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { clearVerifiedCache } from "../../shops/_shared";
import { get, LINES, seedMerchant, seedPayment, sgd, stubSettlement, token, TX } from "../../shops/_testkit";
import { GET } from "./route";

const PAYER = "+6591234567";

async function call(paymentId: string, session?: string) {
  const res = await GET(get(`http://web.test/api/payments/${paymentId}`, session), { params: Promise.resolve({ paymentId }) });
  const text = await res.text();
  return { res, text, body: res.ok ? PaymentStatusRes.parse(JSON.parse(text)) : (JSON.parse(text) as { error: string }) };
}

describe("GET /api/payments/:paymentId", () => {
  let deps: WebTestDeps;
  let payment: Payment;

  beforeEach(async () => {
    clearVerifiedCache();
    deps = await useWebTestDeps({ settlement: stubSettlement({ verified: true }).settlement });
    await seedMerchant(deps.db, { xrplAddress: "rAhSengTestAddress111111111" });
    await seedMerchant(deps.db, { id: "kopi", phone: "+6580000003" });
    payment = await seedPayment(deps.db, "ahseng", { payerPhone: PAYER, charge: money("9.72", "USD") });
    await deps.db.addContact("ahseng", { name: "Maya", phone: PAYER, channel: "imessage" });
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  test("settled payment → PaymentStatusRes with charge, tx, explorer link and receipt extras; no payer phone", async () => {
    const { res, text, body } = await call(payment.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(body, {
      paymentId: payment.id,
      status: "settled",
      local: sgd("12.50"),
      charge: money("9.72", "USD"),
      merchantName: "Ah Seng Chicken Rice",
      createdAt: payment.createdAt,
      refunded: sgd("0.00"),
      merchantVerified: true,
      lines: LINES,
      method: "apple_pay",
      settleTxHash: TX,
      explorerUrl: `https://testnet.xrpl.org/transactions/${TX}`,
    });
    assert.ok(!text.includes("91234567"), "payer phone must never be in the response");
    assert.ok(!text.includes("Maya"), "payerName needs the merchant's sale session");
  });

  test("payerName only for the owning merchant: its sale session for this payment, or its shop session", async () => {
    const ok = token({ merchantId: "ahseng", scope: "sale", ref: payment.id });
    const withName = await call(payment.id, ok);
    assert.equal((withName.body as { payerName?: string }).payerName, "Maya");
    assert.ok(!withName.text.includes("91234567"));
    // /shop links its receipts with the merchant's shop session
    const viaShop = await call(payment.id, token({ merchantId: "ahseng", scope: "shop" }));
    assert.equal((viaShop.body as { payerName?: string }).payerName, "Maya");

    const other = await seedPayment(deps.db, "ahseng", { payerPhone: PAYER });
    const denied = [
      token({ merchantId: "ahseng", scope: "sale", ref: other.id }), // another payment's sale card
      token({ merchantId: "kopi", scope: "sale", ref: payment.id }), // another merchant
      token({ merchantId: "ahseng", scope: "sale" }), // no ref
      token({ merchantId: "kopi", scope: "shop" }), // another merchant's shop
      token({ merchantId: "ahseng", scope: "setup" }),
      token({ merchantId: "ahseng", scope: "sale", ref: payment.id, exp: Math.floor(Date.now() / 1000) - 5 }), // expired
      `${ok.split(".")[0]}.AAAA`, // tampered
    ];
    for (const session of denied) {
      const r = await call(payment.id, session);
      assert.equal(r.res.status, 200, "a bad session never breaks the public receipt");
      assert.equal((r.body as { payerName?: string }).payerName, undefined, session);
    }
  });

  test("an auto-added contact (named after the phone) is never sent as payerName", async () => {
    const p = await seedPayment(deps.db, "ahseng", { payerPhone: "+6598765432" }); // completeSettlement auto-adds it
    const contacts = await deps.db.findContacts("ahseng");
    assert.ok(contacts.some((c) => c.phone === "+6598765432"));
    const r = await call(p.id, token({ merchantId: "ahseng", scope: "sale", ref: p.id }));
    assert.equal((r.body as { payerName?: string }).payerName, undefined);
    assert.ok(!r.text.includes("98765432"));
  });

  test("pending payment: no tx hash, no explorer link", async () => {
    const p = await seedPayment(deps.db, "ahseng", { to: "authorized", payerPhone: null, local: sgd("6.50") });
    const r = await call(p.id);
    assert.equal(r.res.status, 200);
    const body = r.body as { status: string; settleTxHash?: string; explorerUrl?: string; lines: unknown[]; charge?: unknown };
    assert.equal(body.status, "authorized");
    assert.equal(body.settleTxHash, undefined);
    assert.equal(body.explorerUrl, undefined);
    assert.deepEqual(body.lines, []);
    assert.deepEqual(body.charge, sgd("6.50"));
  });

  test("refunds show in refunded + status", async () => {
    await deps.db.addPaymentRefund(payment.id, sgd("5.50"));
    const r = await call(payment.id);
    const body = r.body as { status: string; refunded?: unknown };
    assert.equal(body.status, "partially_refunded");
    assert.deepEqual(body.refunded, sgd("5.50"));
  });

  test("unknown id → 404 payment_not_found", async () => {
    const r = await call("pay_doesnotexist");
    assert.equal(r.res.status, 404);
    assert.equal(r.res.headers.get("cache-control"), "no-store");
    assert.equal((r.body as { error: string }).error, "payment_not_found");
  });
});
