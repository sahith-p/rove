// Invoices, one-time QR codes and pay requests: codes, lookups, totals, expiry, cancel, reminders.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { InvoiceKind } from "@rove/shared";
import type { Db, NewInvoice } from "./index";
import { liveMerchant, openTestDb, paymentInput, sgd } from "./testkit";

let db: Db;
before(async () => {
  ({ db } = await openTestDb());
  await liveMerchant(db, "inv", "Invoice Shop");
  await liveMerchant(db, "other", "Other Shop");
});
after(() => db.close());

const MIN = 60_000;
const one = (kind: InvoiceKind, over: Partial<NewInvoice> = {}): NewInvoice => ({
  merchantId: "inv",
  kind,
  lines: [{ menuItemId: null, name: "Payment", qty: 1, unit: sgd("6.50") }],
  total: sgd("6.50"),
  ...over,
});

describe("codes", () => {
  it("6 characters without 0/O/1/I, unique, looked up case-insensitively", async () => {
    const created = await Promise.all(Array.from({ length: 40 }, () => db.createInvoice(one("one_time_qr"))));
    for (const i of created) assert.match(i.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    assert.equal(new Set(created.map((i) => i.code)).size, created.length);
    const first = created[0]!;
    assert.match(first.id, /^inv_[0-9a-f]{32}$/);
    assert.equal((await db.getInvoiceByCode(first.code.toLowerCase()))?.id, first.id);
    assert.equal((await db.getInvoiceByCode(` ${first.code} `))?.id, first.id);
    assert.equal(await db.getInvoiceByCode("NOPE22"), null);
  });

  it("draws a new code on a collision, and gives up after 10 tries", async () => {
    const queue = ["K7Q2MX", "K7Q2MX", "K7Q2MX", "ZZZZZZ"];
    const { db: d } = await openTestDb({ newCode: () => queue.shift() ?? "K7Q2MX" });
    try {
      await liveMerchant(d, "inv");
      assert.equal((await d.createInvoice(one("invoice"))).code, "K7Q2MX");
      assert.equal((await d.createInvoice(one("invoice"))).code, "ZZZZZZ");
      await assert.rejects(() => d.createInvoice(one("invoice")), /unique invoice code/);
    } finally {
      await d.close();
    }
  });
});

describe("createInvoice", () => {
  it("defaults the expiry by kind and keeps an explicit one", async () => {
    const now = Date.now();
    const exp = async (kind: InvoiceKind) => Date.parse((await db.createInvoice(one(kind))).expiresAt) - now;
    const near = (ms: number, target: number) => assert.ok(Math.abs(ms - target) < MIN, `${ms} ≉ ${target}`);
    near(await exp("invoice"), 7 * 24 * 60 * MIN);
    near(await exp("one_time_qr"), 30 * MIN);
    near(await exp("pay_request"), 60 * MIN);
    const at = new Date(now + 5 * MIN).toISOString();
    assert.equal((await db.createInvoice(one("invoice", { expiresAt: at }))).expiresAt, at);
  });

  it("re-checks Σ qty × unit against the total", async () => {
    const lines = [
      { menuItemId: "item_a", name: "Chicken rice", qty: 2, unit: sgd("5.50") },
      { menuItemId: "item_b", name: "Barley drink", qty: 1, unit: sgd("1.50") },
    ];
    const ok = await db.createInvoice(one("invoice", { lines, total: sgd("12.50"), note: "no chilli" }));
    assert.deepEqual(ok.lines, lines);
    assert.deepEqual(ok.total, sgd("12.50"));
    assert.equal(ok.note, "no chilli");
    await assert.rejects(() => db.createInvoice(one("invoice", { lines, total: sgd("12.00") })), /doesn't match/);
    await assert.rejects(() => db.createInvoice(one("invoice", { lines: [], total: sgd("1.00") })), /doesn't match/);
    await assert.rejects(() => db.createInvoice(one("invoice", { lines: [{ ...lines[0]!, qty: 1.5 }], total: sgd("8.25") })), /invalid qty/);
    await assert.rejects(() => db.createInvoice(one("invoice", { lines: [], total: sgd("0") })), /positive/);
  });

  it("stores the recipient normalized; customers see their open invoices and pay requests", async () => {
    const to = { phone: "+65 9123 4567", channel: "whatsapp" as const };
    const inv = await db.createInvoice(one("invoice", { to }));
    const req = await db.createInvoice(one("pay_request", { to, merchantId: "other" }));
    await db.createInvoice(one("one_time_qr"));
    assert.deepEqual(inv.to, { phone: "+6591234567", channel: "whatsapp" });
    assert.deepEqual(
      (await db.openInvoicesForPhone("+6591234567")).map((i) => i.id).sort(),
      [inv.id, req.id].sort(),
    );
    assert.deepEqual(await db.openInvoicesForPhone("+6500000000"), []);
  });
});

describe("lifecycle", () => {
  it("expireInvoices expires what's past due, once, and skips codes with a payment in flight", async () => {
    const { db: d } = await openTestDb();
    try {
      await liveMerchant(d, "inv");
      const qr = await d.createInvoice(one("one_time_qr"));
      const req = await d.createInvoice(one("pay_request"));
      const inv = await d.createInvoice(one("invoice"));
      const busy = await d.createInvoice(one("one_time_qr"));
      const p = paymentInput("inv", sgd("6.50"), { source: "one_time_qr", invoiceId: busy.id });
      await d.insertPayment(p);
      await d.transitionPayment(p.id, ["created"], "authorized");

      const at31 = new Date(Date.now() + 31 * MIN);
      const first = await d.expireInvoices(at31);
      assert.deepEqual(first.map((i) => [i.id, i.status]), [[qr.id, "expired"]]);
      assert.deepEqual(await d.expireInvoices(at31), []);
      assert.deepEqual((await d.expireInvoices(new Date(Date.now() + 61 * MIN))).map((i) => i.id), [req.id]);
      assert.equal((await d.getInvoiceByCode(qr.code))?.status, "expired");
      assert.equal((await d.getInvoice(inv.id))?.status, "open");
      assert.equal((await d.getInvoice(busy.id))?.status, "open");

      // the in-flight payment still lands
      await d.transitionPayment(p.id, ["authorized"], "settling");
      await d.completeSettlement(p.id, { txHash: "T", delivered: "6.50" });
      assert.equal((await d.getInvoice(busy.id))?.status, "paid");
    } finally {
      await d.close();
    }
  });

  it("listInvoices, markInvoicePaid, cancelInvoice", async () => {
    const { db: d } = await openTestDb();
    try {
      await liveMerchant(d, "inv");
      await liveMerchant(d, "other");
      const a = await d.createInvoice(one("invoice"));
      const b = await d.createInvoice(one("invoice"));
      const c = await d.createInvoice(one("one_time_qr"));
      assert.equal((await d.listInvoices("inv", "open")).length, 3);

      assert.equal(await d.markInvoicePaid(a.id, "pay_x"), true);
      assert.equal(await d.markInvoicePaid(a.id, "pay_y"), false);
      assert.equal((await d.getInvoice(a.id))?.paymentId, "pay_x");

      assert.equal(await d.cancelInvoice("other", b.code), false); // not theirs
      assert.equal(await d.cancelInvoice("inv", b.code.toLowerCase()), true);
      assert.equal(await d.cancelInvoice("inv", b.code), false);
      assert.equal(await d.cancelInvoice("inv", a.code), false); // already paid

      assert.deepEqual((await d.listInvoices("inv", "open")).map((i) => i.id), [c.id]);
      assert.deepEqual((await d.listInvoices("inv", "paid")).map((i) => i.id), [a.id]);
      assert.equal((await d.listInvoices("inv", "all")).length, 3);
      assert.deepEqual(
        (await d.listInvoices("inv", "all")).map((i) => i.status).sort(),
        ["cancelled", "open", "paid"],
      );
    } finally {
      await d.close();
    }
  });

  it("invoicesToRemind: open person-to-person invoices older than the cutoff, reminded once", async () => {
    const { db: d } = await openTestDb();
    try {
      await liveMerchant(d, "inv");
      const inv = await d.createInvoice(one("invoice", { to: { phone: "+6591234567", channel: "imessage" } }));
      await d.createInvoice(one("one_time_qr"));
      assert.deepEqual(await d.invoicesToRemind(new Date(Date.now() - MIN)), []); // not old enough
      const later = new Date(Date.now() + MIN);
      assert.deepEqual((await d.invoicesToRemind(later)).map((i) => i.id), [inv.id]);
      assert.deepEqual((await d.invoicesDueForReminder(later.toISOString())).map((i) => i.id), [inv.id]);
      assert.equal(await d.markInvoiceReminded(inv.id), true); // CAS: the first caller wins
      assert.equal(await d.markInvoiceReminded(inv.id), false);
      assert.deepEqual(await d.invoicesToRemind(later), []);
    } finally {
      await d.close();
    }
  });
});
