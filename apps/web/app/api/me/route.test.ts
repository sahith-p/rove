import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MeRes, type Money } from "@rove/shared";
import type { z } from "zod";
import { setWebDepsForTests } from "../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { clearVerifiedCache } from "../shops/_shared";
import { get, one, seedMerchant, seedPayment, sgd, stubSettlement, token } from "../shops/_testkit";
import { GET } from "./route";

type Me = z.infer<typeof MeRes>;
const ADDRESS = "rAhSengTestAddress111111111";
const MAYA = "+6591234567";

async function call(session?: string): Promise<{ res: Response; me: Me | null; raw: Record<string, unknown> }> {
  const res = await GET(get("http://web.test/api/me", session), {});
  const raw = (await res.json()) as Record<string, unknown>;
  return { res, me: res.ok ? MeRes.parse(raw) : null, raw };
}
const shop = () => token({ merchantId: "ahseng", scope: "shop" });

describe("GET /api/me", () => {
  let deps: WebTestDeps;
  let stub: ReturnType<typeof stubSettlement>;

  beforeEach(async () => {
    clearVerifiedCache();
    stub = stubSettlement({ verified: true, balance: sgd("0") });
    deps = await useWebTestDeps({ settlement: stub.settlement });
    await seedMerchant(deps.db, { xrplAddress: ADDRESS });
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  /** 11 settled sales of S$12.50 (S$137.50), one abandoned checkout, a S$50 withdrawal approved (held). */
  async function seedShop() {
    const db = deps.db;
    await db.replaceMenu("ahseng", [
      { name: "Chicken rice", price: sgd("5.50") },
      { name: "Soup of the day", price: sgd("2.00"), active: false },
    ]);
    await db.addContact("ahseng", { name: "Maya", phone: MAYA, channel: "imessage" });
    const toMaya = await db.createInvoice({ merchantId: "ahseng", kind: "invoice", to: { phone: MAYA, channel: "imessage" }, lines: one("10.00"), total: sgd("10.00") });
    const qr = await db.createInvoice({ merchantId: "ahseng", kind: "one_time_qr", lines: one("6.50"), total: sgd("6.50") });
    await db.createInvoice({ merchantId: "ahseng", kind: "one_time_qr", lines: one("1.00"), total: sgd("1.00"), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const paid = await db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: one("2.00"), total: sgd("2.00") });
    await db.markInvoicePaid(paid.id, "pay_x");
    for (let i = 0; i < 11; i++) await seedPayment(db, "ahseng", { payerPhone: MAYA });
    const abandoned = await seedPayment(db, "ahseng", { to: "created" });
    const bank = await db.insertBankAccount({
      merchantId: "ahseng",
      type: "bank_account",
      bankName: "DBS",
      last4: "1234",
      holderName: "AH SENG FOOD PTE LTD",
      beneficiaryId: "ben_test",
      status: "verified",
    });
    const wd = await db.insertWithdrawal({
      merchantId: "ahseng",
      amount: sgd("50.00"),
      fee: sgd("0.00"),
      destination: { kind: "bank", bankAccountId: bank.id },
      needsStepUp: false,
    });
    const approved = await db.approveWithdrawal(wd.id, "act_test");
    assert.equal(approved.ok, true);
    return { toMaya, qr, abandoned, bank, wd };
  }

  test("MeRes: merchant, ledger balance, menu incl. hidden, contacts, open invoices, last 10 payments, bank, withdrawals", async () => {
    const s = await seedShop();
    stub.state.balance = sgd("137.50");
    const { res, me } = await call(shop());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(me);

    assert.deepEqual(me.merchant, {
      id: "ahseng",
      name: "Ah Seng Chicken Rice",
      category: "hawker",
      currency: "SGD",
      status: "live",
      autoWithdraw: "off",
      verified: true,
    });
    assert.deepEqual(me.balance, { available: sgd("87.50"), held: sgd("50.00"), total: sgd("137.50") });
    assert.equal(me.reconciled, true);
    assert.deepEqual(
      me.menu.map((m) => [m.name, m.price, m.active]),
      [
        ["Chicken rice", sgd("5.50"), true],
        ["Soup of the day", sgd("2.00"), false],
      ],
    );
    assert.deepEqual(
      me.contacts.map((c) => [c.name, c.phone]),
      [["Maya", MAYA]],
    );
    assert.deepEqual(
      me.openInvoices.map((i) => [i.code, i.to, i.total]).sort(),
      [
        [s.qr.code, null, sgd("6.50")],
        [s.toMaya.code, MAYA, sgd("10.00")],
      ].sort(),
    );
    assert.equal(me.recentPayments.length, 10);
    assert.ok(me.recentPayments.every((p) => p.status === "settled" && p.source === "fixed_qr"));
    assert.ok(!me.recentPayments.some((p) => p.id === s.abandoned.id), "an abandoned checkout isn't a payment");
    assert.deepEqual(me.bankAccounts, [
      { id: s.bank.id, type: "bank_account", bankName: "DBS", last4: "1234", holderName: "AH SENG FOOD PTE LTD", status: "verified", isDefault: true },
    ]);
    assert.equal(me.withdrawals.length, 1);
    assert.equal(me.withdrawals[0]?.id, s.wd.id);
    assert.equal(me.withdrawals[0]?.status, "approved");
    assert.deepEqual(me.withdrawals[0]?.destination, { kind: "bank", label: "DBS ••••1234" });
    assert.deepEqual(stub.calls.balance, [ADDRESS]);
  });

  test("a fresh shop parses too (empty lists, zero balance)", async () => {
    const { me } = await call(shop());
    assert.ok(me);
    assert.deepEqual(me.balance, { available: sgd("0.00"), held: sgd("0.00"), total: sgd("0.00") });
    assert.deepEqual([me.menu, me.contacts, me.openInvoices, me.recentPayments, me.bankAccounts, me.withdrawals], [[], [], [], [], [], []]);
    assert.equal(me.reconciled, true); // 0 on the ledger, 0 on XRPL
  });

  describe("reconciled", () => {
    const check = async (balance: Money | Error | "hang") => {
      await seedPayment(deps.db, "ahseng"); // S$12.50 on the ledger
      stub.state.balance = balance;
      return call(shop());
    };

    test("true when available + held equals the XRPL balance (trailing zeros don't matter)", async () => {
      assert.equal((await check({ amount: "12.500000", currency: "SGD" })).me?.reconciled, true);
    });
    test("false when they differ, even by dust", async () => {
      assert.equal((await check(sgd("12.49"))).me?.reconciled, false);
      assert.equal((await call(shop())).me?.reconciled, false);
      stub.state.balance = { amount: "12.500001", currency: "SGD" };
      assert.equal((await call(shop())).me?.reconciled, false);
    });
    test("omitted when the engine fails", async () => {
      const { res, raw } = await check(new Error("xrpl down"));
      assert.equal(res.status, 200);
      assert.equal("reconciled" in raw, false);
    });
    test("omitted when the engine takes longer than 1.5s", async () => {
      const t = Date.now();
      const { res, raw } = await check("hang");
      assert.equal(res.status, 200);
      assert.equal("reconciled" in raw, false);
      assert.ok(Date.now() - t < 3000);
    });
    test("omitted (and XRPL not asked) when the merchant has no XRPL account", async () => {
      await seedMerchant(deps.db, { id: "draftshop", phone: "+6580000002", live: false });
      const { res, raw } = await call(token({ merchantId: "draftshop", scope: "setup" }));
      assert.equal(res.status, 200);
      assert.equal("reconciled" in raw, false);
      assert.equal((raw.merchant as { status: string }).status, "draft");
      assert.deepEqual(stub.calls.balance, []);
    });
  });

  test("any scope can read its own shop; no / bad session can't; unknown merchant → 404", async () => {
    for (const scope of ["setup", "bank", "shop", "withdrawal", "sale"] as const) {
      const r = await call(token({ merchantId: "ahseng", scope, ...(scope === "withdrawal" || scope === "sale" ? { ref: "x" } : {}) }));
      assert.equal(r.res.status, 200, scope);
      assert.equal(r.me?.merchant.id, "ahseng");
    }
    assert.equal((await call()).res.status, 401);
    assert.equal((await call("garbage")).res.status, 401);
    assert.equal((await call(token({ merchantId: "ahseng", scope: "shop", exp: Math.floor(Date.now() / 1000) - 1 }))).res.status, 401);
    const ghost = await call(token({ merchantId: "ghost", scope: "shop" }));
    assert.equal(ghost.res.status, 404);
    assert.equal(ghost.raw.error, "merchant_not_found");
  });
});
