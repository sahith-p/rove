// AUSD lane storage: authorization once per payment, idempotent retries, one payment per (from, nonce), relay bookkeeping.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { money, newId, type InvoiceLine } from "@rove/shared";
import { DbConflictError, type AusdAuthorization, type Db, type NewPayment } from "./index";
import { createTestDb } from "./testing";

const FROM = "0x57db62B364808Ad7FFa7210169c2abeA2ef39B25";
const TO = "0xaD0E193bcd9A035aCb383681Bb21F7C3099f584B";
const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const sig = (b: string) => `0x${b.repeat(130)}`;

function auth(overrides: Partial<AusdAuthorization> = {}): AusdAuthorization {
  return { from: FROM, to: TO, value: "9700000", validAfter: "0", validBefore: "1900000000", nonce: nonce(1), signature: sig("a"), ...overrides };
}

const LINES: InvoiceLine[] = [{ menuItemId: null, name: "Chicken rice", qty: 1, unit: money("12.50", "SGD") }];

function newPayment(method: NewPayment["method"] = "ausd"): NewPayment {
  return {
    id: newId("pay"),
    merchantId: "ahseng",
    source: "fixed_qr",
    invoiceId: null,
    lines: LINES,
    local: money("12.50", "SGD"),
    quote: { local: money("12.50", "SGD"), usd: money("9.70", "USD"), rate: "1.29", sendMaxUsd: "9.80", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    charge: money("9.70", "USD"),
    method,
    payer: null,
  };
}

describe("AUSD lane storage", () => {
  let db: Db;
  before(async () => {
    db = await createTestDb({ demo: true });
  });
  after(() => db.close());

  it("stores the authorization once; the same one again is an idempotent ok; a different one is refused", async () => {
    const p = await db.insertPayment(newPayment());
    const first = await db.setAusdAuthorization(p.id, auth({ nonce: nonce(10) }));
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.alreadyStored, false);

    const again = await db.setAusdAuthorization(p.id, auth({ nonce: nonce(10), value: "0009700000" }));
    assert.equal(again.ok && again.alreadyStored, true);

    const other = await db.setAusdAuthorization(p.id, auth({ nonce: nonce(10), signature: sig("b") }));
    assert.deepEqual([other.ok, !other.ok && other.reason], [false, "different_authorization"]);

    const state = await db.getAusdRelay(p.id);
    assert.equal(state?.authorization.value, "9700000");
    assert.equal(state?.authorization.nonce, nonce(10));
    assert.equal(state?.relayTxHash, null);
    assert.equal(state?.relayAttempts, 0);
  });

  it("refuses non-ausd, unknown and non-created payments", async () => {
    const card = await db.insertPayment(newPayment("card"));
    const r1 = await db.setAusdAuthorization(card.id, auth({ nonce: nonce(20) }));
    assert.equal(!r1.ok && r1.reason, "not_ausd");

    const r2 = await db.setAusdAuthorization("pay_missing", auth({ nonce: nonce(21) }));
    assert.equal(!r2.ok && r2.reason, "not_found");

    const p = await db.insertPayment(newPayment());
    await db.transitionPayment(p.id, ["created"], "failed", { failureReason: "test" });
    const r3 = await db.setAusdAuthorization(p.id, auth({ nonce: nonce(22) }));
    assert.equal(!r3.ok && r3.reason, "not_created");
  });

  it("one (from, nonce) pays one payment, case-insensitively", async () => {
    const a = await db.insertPayment(newPayment());
    const b = await db.insertPayment(newPayment());
    assert.equal((await db.setAusdAuthorization(a.id, auth({ nonce: nonce(30) }))).ok, true);
    const reused = await db.setAusdAuthorization(b.id, auth({ from: FROM.toLowerCase(), nonce: nonce(30) }));
    assert.equal(!reused.ok && reused.reason, "authorization_reused");
    assert.equal((await db.getPaymentByAusdNonce(FROM.toUpperCase().replace("0X", "0x"), nonce(30)))?.id, a.id);

    await assert.rejects(db.insertAusdPayment(newPayment(), auth({ nonce: nonce(30) })), DbConflictError);
  });

  it("insertAusdPayment creates the payment with its authorization in one go", async () => {
    const p = await db.insertAusdPayment(newPayment(), auth({ nonce: nonce(40) }));
    assert.equal(p.method, "ausd");
    assert.equal(p.status, "created");
    assert.equal((await db.getAusdRelay(p.id))?.authorization.nonce, nonce(40));
    await assert.rejects(db.insertAusdPayment(newPayment("card"), auth({ nonce: nonce(41) })), /needs method "ausd"/);
    await assert.rejects(db.insertAusdPayment(newPayment(), auth({ nonce: "0x12" })), /invalid AUSD authorization nonce/);
  });

  it("relay queue: created + signed only; tx hash recorded with attempts; authorized leaves the queue with payinTxHash", async () => {
    const fresh = await createTestDb({ demo: true });
    try {
      const unsigned = await fresh.insertPayment(newPayment());
      const signed = await fresh.insertAusdPayment(newPayment(), auth({ nonce: nonce(50) }));
      const queue = await fresh.listAusdAwaitingRelay();
      assert.deepEqual(
        queue.map((s) => s.payment.id),
        [signed.id],
      );
      assert.notEqual(queue[0]!.payment.id, unsigned.id);

      const tx = `0x${"c".repeat(64)}`;
      assert.equal(await fresh.setAusdRelayTx(signed.id, tx), true);
      assert.equal(await fresh.setAusdRelayTx(signed.id, tx), true);
      const s = await fresh.getAusdRelay(signed.id);
      assert.deepEqual([s?.relayTxHash, s?.relayAttempts], [tx, 2]);
      await assert.rejects(fresh.setAusdRelayTx(signed.id, "0xnope"), /invalid relay tx hash/);

      await fresh.transitionPayment(signed.id, ["created"], "authorized", { payinTxHash: tx });
      assert.deepEqual(await fresh.listAusdAwaitingRelay(), []);
      assert.equal((await fresh.getAusdRelay(signed.id))?.payinTxHash, tx);
      assert.equal(await fresh.setAusdRelayTx(signed.id, `0x${"d".repeat(64)}`), false);
    } finally {
      await fresh.close();
    }
  });
});
