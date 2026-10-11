// Merchants (draft → live), the menu (replace / upsert), bank accounts, and the public createTestDb() entry.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEMO_MENU, DEMO_MERCHANT } from "@rove/shared/mocks";
import { createDb, DbConflictError, type Db } from "./index";
import { createTestDb } from "./testing";
import { openTestDb, sgd } from "./testkit";

let db: Db;
before(async () => ({ db } = await openTestDb()));
after(() => db.close());

describe("merchants", () => {
  it("upsertDraftMerchant is idempotent for the same phone and refuses someone else's slug", async () => {
    const m = await db.upsertDraftMerchant({ id: "ahseng", name: "Ah Seng", phone: "+65 9000 1234", channel: "imessage", category: "hawker" });
    assert.deepEqual(
      [m.status, m.currency, m.country, m.phone, m.category, m.xrplAddress, m.credentialStatus, m.autoWithdraw],
      ["draft", "SGD", "SG", "+6590001234", "hawker", null, "none", "off"],
    );
    const again = await db.upsertDraftMerchant({ id: "ahseng", name: "Ah Seng Chicken Rice", phone: "+6590001234", channel: "imessage" });
    assert.equal(again.name, "Ah Seng Chicken Rice");
    assert.equal(again.category, "hawker"); // kept when omitted
    assert.equal(again.createdAt, m.createdAt);

    await assert.rejects(
      () => db.upsertDraftMerchant({ id: "ahseng", name: "Imposter", phone: "+6590009999", channel: "whatsapp" }),
      (e: unknown) => e instanceof DbConflictError && e.constraint === "merchants_pkey",
    );
    await assert.rejects(
      () => db.upsertDraftMerchant({ id: "ahseng2", name: "Second shop", phone: "+6590001234", channel: "imessage" }),
      (e: unknown) => e instanceof DbConflictError && e.constraint === "merchants_phone_key",
    );
    assert.equal((await db.getMerchant("ahseng"))?.name, "Ah Seng Chicken Rice");
  });

  it("finds a merchant by phone in any format", async () => {
    assert.equal((await db.getMerchantByPhone("+6590001234"))?.id, "ahseng");
    assert.equal((await db.getMerchantByPhone("+65 9000-1234"))?.id, "ahseng");
    assert.equal((await db.getMerchantByPhone("6590001234"))?.id, "ahseng");
    assert.equal(await db.getMerchantByPhone("+6511111111"), null);
    assert.equal(await db.getMerchantByPhone(""), null);
  });

  it("records the XRPL account without ever returning the seed, then goes live once", async () => {
    const m = await db.setMerchantXrpl("ahseng", { xrplAddress: "rAhSeng", xrplSeedEnc: "enc:secret", credentialStatus: "accepted" });
    assert.equal(m?.xrplAddress, "rAhSeng");
    assert.equal(m?.credentialStatus, "accepted");
    assert.ok(!JSON.stringify(m).includes("enc:secret"));
    assert.ok(!JSON.stringify(await db.getMerchant("ahseng")).includes("enc:secret"));
    assert.equal(await db.getMerchantSeedEnc("rAhSeng"), "enc:secret");
    assert.equal(await db.getMerchantSeedEnc("rNobody"), null);

    assert.ok(!(await db.listLiveMerchants()).some((x) => x.id === "ahseng"));
    assert.equal((await db.setMerchantLive("ahseng"))?.status, "live");
    assert.equal(await db.setMerchantLive("ahseng"), null); // CAS: already live
    assert.ok((await db.listLiveMerchants()).some((x) => x.id === "ahseng"));
  });

  it("updateShop and setAutoWithdraw", async () => {
    assert.equal((await db.updateShop("ahseng", { category: null }))?.category, null);
    assert.equal((await db.updateShop("ahseng", { name: "Ah Seng CR" }))?.name, "Ah Seng CR");
    assert.equal((await db.updateShop("ahseng", {}))?.name, "Ah Seng CR");
    assert.equal(await db.updateShop("nobody", { name: "x" }), null);
    await db.setAutoWithdraw("ahseng", "daily");
    assert.equal((await db.getMerchant("ahseng"))?.autoWithdraw, "daily");
  });
});

describe("menu", () => {
  it("replaceMenu keeps ids, deactivates what's gone, renames and swaps safely", async () => {
    const first = await db.replaceMenu("ahseng", [
      { name: "Chicken rice", price: sgd("5.50") },
      { name: "Barley drink", price: sgd("1.50") },
    ]);
    const [rice, barley] = first;
    assert.deepEqual(first.map((i) => [i.name, i.price.amount, i.sort, i.active]), [
      ["Chicken rice", "5.50", 1, true],
      ["Barley drink", "1.50", 2, true],
    ]);

    const second = await db.replaceMenu("ahseng", [
      { id: rice!.id, name: "Chicken rice (large)", price: sgd("6.00") },
      { name: "Kopi", price: sgd("1.2") },
    ]);
    assert.equal(second[0]!.id, rice!.id);
    assert.deepEqual(second.map((i) => [i.name, i.price.amount]), [
      ["Chicken rice (large)", "6.00"],
      ["Kopi", "1.20"],
    ]);
    assert.deepEqual((await db.listMenu("ahseng")).map((i) => i.name), ["Chicken rice (large)", "Kopi"]);
    const all = await db.listMenu("ahseng", { includeInactive: true });
    assert.deepEqual(all.find((i) => i.id === barley!.id)?.active, false); // deactivated, not deleted

    // swap two names, and bring the barley back by name (same row, reactivated)
    const kopi = second[1]!;
    const third = await db.replaceMenu("ahseng", [
      { id: rice!.id, name: "Kopi", price: sgd("1.20") },
      { id: kopi.id, name: "Chicken rice (large)", price: sgd("6.00") },
      { name: "barley drink", price: sgd("1.60") },
    ]);
    assert.deepEqual(third.map((i) => [i.id, i.name]), [
      [rice!.id, "Kopi"],
      [kopi.id, "Chicken rice (large)"],
      [barley!.id, "barley drink"],
    ]);
    assert.ok(third.every((i) => i.active));

    await assert.rejects(
      () => db.replaceMenu("ahseng", [{ name: "Tea", price: sgd("1") }, { name: " tea ", price: sgd("1") }]),
      (e: unknown) => e instanceof DbConflictError,
    );
    await assert.rejects(() => db.replaceMenu("nobody", []), /unknown merchant/);
  });

  it("upsertMenuItem adds at the end, updates by name, and needs a price for new items", async () => {
    const before = await db.listMenu("ahseng");
    const added = await db.upsertMenuItem("ahseng", { name: "Teh tarik", price: sgd("1.80") });
    assert.equal(added.sort, Math.max(...before.map((i) => i.sort)) + 1);
    const repriced = await db.upsertMenuItem("ahseng", { name: "TEH TARIK", price: sgd("2.00") });
    assert.equal(repriced.id, added.id);
    assert.equal(repriced.name, "Teh tarik");
    assert.deepEqual(repriced.price, sgd("2.00"));
    const off = await db.upsertMenuItem("ahseng", { name: "teh tarik", active: false });
    assert.equal(off.active, false);
    assert.deepEqual(off.price, sgd("2.00"));
    await assert.rejects(() => db.upsertMenuItem("ahseng", { name: "Milo" }), /needs a price/);
  });
});

describe("bank accounts", () => {
  it("the first account is the default; only id + last 4 are kept", async () => {
    const a = await db.insertBankAccount({
      merchantId: "ahseng",
      type: "paynow_uen",
      bankName: null,
      last4: "567A",
      holderName: "AH SENG FOOD PTE LTD",
      beneficiaryId: "ben_a",
      status: "verified",
    });
    const b = await db.insertBankAccount({
      merchantId: "ahseng",
      type: "bank_account",
      bankName: "DBS/POSB",
      last4: "1234",
      holderName: "AH SENG FOOD PTE LTD",
      beneficiaryId: "ben_b",
      status: "pending",
    });
    assert.equal(a.isDefault, true);
    assert.equal(b.isDefault, false);
    assert.equal((await db.getDefaultBankAccount("ahseng"))?.id, a.id);
    assert.deepEqual((await db.listBankAccounts("ahseng")).map((x) => x.id), [a.id, b.id]);
    assert.equal((await db.getBankAccount(b.id))?.bankName, "DBS/POSB");
    assert.equal(await db.getDefaultBankAccount("nobody"), null);
  });
});

describe("entry points", () => {
  it("createTestDb({ demo: true }) has the fixture shop, menu and contact", async () => {
    const t = await createTestDb({ demo: true });
    try {
      const m = await t.getMerchant(DEMO_MERCHANT.id);
      assert.equal(m?.status, "live");
      assert.deepEqual((await t.listMenu(DEMO_MERCHANT.id)).map((i) => i.id), DEMO_MENU.map((i) => i.id));
      assert.equal((await t.findContacts(DEMO_MERCHANT.id)).length, 1);
      assert.deepEqual(await t.getBalance(DEMO_MERCHANT.id), { available: sgd("0"), held: sgd("0"), total: sgd("0") });
    } finally {
      await t.close();
    }
    const empty = await createTestDb();
    try {
      assert.equal(await empty.getMerchant(DEMO_MERCHANT.id), null);
    } finally {
      await empty.close();
    }
  });

  it("createDb without DATABASE_URL fails clearly", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.throws(() => createDb(), /DATABASE_URL is not set/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
