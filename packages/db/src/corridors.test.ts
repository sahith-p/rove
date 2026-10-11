// Corridors Phase B (docs/specs/corridors.md §7): the payer's route round-trips, merchants keep their own country,
// EUR shops hold IBAN bank accounts, and the EUR demo shop seeds.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { money, type Quote } from "@rove/shared";
import { seedEurDemoData } from "./demo";
import type { Pool } from "./executor";
import type { Db } from "./index";
import { liveMerchant, openTestDb, paymentInput, sgd } from "./testkit";

let db: Db;
let pool: Pool;
before(async () => ({ db, pool } = await openTestDb()));
after(() => db.close());

const eur = (a: string) => money(a, "EUR");

describe("payments: the payer-currency route", () => {
  it("stores quote.pay / sendMax in the payer's currency and reads them back", async () => {
    const m = await liveMerchant(db, "route-sgd");
    const local = sgd("12.50");
    const quote: Quote = {
      local,
      usd: money("9.76", "USD"),
      rate: "1.3812",
      sendMaxUsd: "9.86",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pay: eur("9.05"),
      sendMax: "9.15",
    };
    const p = await db.insertPayment(paymentInput(m.id, local, { quote, charge: eur("9.05") }));
    assert.deepEqual(p.quote?.pay, eur("9.05"));
    assert.equal(p.quote?.sendMax, "9.15");
    assert.equal(p.quote?.rate, "1.3812");
    assert.deepEqual(p.charge, eur("9.05"));
    const [row] = await pool.query<{ quote_from: string; quote_pay: string; quote_send_max: string }>(
      `select quote_from, quote_pay::text, quote_send_max::text from payments where id = $1`,
      [p.id],
    );
    assert.deepEqual([row!.quote_from, Number(row!.quote_pay), Number(row!.quote_send_max)], ["EUR", 9.05, 9.15]);
    assert.deepEqual((await db.getPayment(p.id))?.quote, p.quote);

    // a re-quote patch replaces the route; a quote without `pay` clears it
    const next = await db.transitionPayment(p.id, ["created"], "created", { quote: { ...quote, pay: eur("9.06"), sendMax: "9.16" } });
    assert.deepEqual([next?.quote?.pay?.amount, next?.quote?.sendMax], ["9.06", "9.16"]);
    const { pay: _pay, sendMax: _sendMax, ...usdOnly } = quote;
    const cleared = await db.transitionPayment(p.id, ["created"], "created", { quote: usdOnly });
    assert.equal(cleared?.quote?.pay, undefined);
    assert.equal(cleared?.quote?.sendMax, undefined);
  });

  it("USD-only quotes (no pay) still round-trip exactly as before", async () => {
    const m = await liveMerchant(db, "route-usd");
    const p = await db.insertPayment(paymentInput(m.id, sgd("12.50")));
    assert.deepEqual(Object.keys(p.quote!).sort(), ["expiresAt", "local", "rate", "sendMaxUsd", "usd"]);
  });
});

describe("merchants: country", () => {
  it("defaults from the currency, keeps an explicit one, and follows a currency change", async () => {
    const sg = await db.upsertDraftMerchant({ id: "cty-sg", name: "Kopi", phone: "+6590001111", channel: "whatsapp" });
    assert.equal(sg.country, "SG");
    const de = await db.upsertDraftMerchant({ id: "cty-de", name: "Bäckerei", phone: "+4915100001111", channel: "whatsapp", currency: "EUR" });
    assert.deepEqual([de.currency, de.country], ["EUR", "DE"]);
    const at = await db.upsertDraftMerchant({ id: "cty-at", name: "Kaffeehaus", phone: "+4366400001111", channel: "whatsapp", currency: "EUR", country: "at" });
    assert.equal(at.country, "AT");
    // re-upserting the same currency keeps AT; switching currency without a country moves it to the default
    assert.equal((await db.upsertDraftMerchant({ id: "cty-at", name: "Kaffeehaus", phone: "+4366400001111", channel: "whatsapp", currency: "EUR" })).country, "AT");
    assert.equal((await db.upsertDraftMerchant({ id: "cty-sg", name: "Kopi", phone: "+6590001111", channel: "whatsapp", currency: "EUR" })).country, "DE");
    // updateShop: a country that uses the new currency stays, anything else moves to the default
    assert.equal((await db.updateShop("cty-at", { currency: "EUR" }))?.country, "AT");
    assert.equal((await db.updateShop("cty-at", { currency: "SGD" }))?.country, "SG");
    assert.equal((await db.getMerchant("cty-at"))?.country, "SG");
  });
});

describe("bank accounts: IBAN", () => {
  it("stores an iban account (last 4 + beneficiary id only)", async () => {
    await seedEurDemoData(pool);
    const b = await db.insertBankAccount({
      merchantId: "cafe-berlin",
      type: "iban",
      bankName: null,
      last4: "3000",
      holderName: "CAFÉ BERLIN GMBH",
      beneficiaryId: "sepa_bene_1",
      status: "verified",
    });
    assert.deepEqual([b.type, b.last4, b.isDefault], ["iban", "3000", true]);
  });
});

describe("demo: cafe-berlin", () => {
  it("seeds a live EUR shop in DE with an EUR menu, idempotently", async () => {
    await seedEurDemoData(pool, { xrplAddress: "rGheZs4JF12rHYSNubKzKwZUJymKQCpwSB", xrplSeedEnc: "enc", credentialStatus: "accepted" });
    await seedEurDemoData(pool);
    const m = await db.getMerchant("cafe-berlin");
    assert.deepEqual([m?.status, m?.currency, m?.country, m?.xrplAddress, m?.credentialStatus], ["live", "EUR", "DE", "rGheZs4JF12rHYSNubKzKwZUJymKQCpwSB", "accepted"]);
    const menu = await db.listMenu("cafe-berlin");
    assert.equal(menu.length, 4);
    assert.ok(menu.every((i) => i.price.currency === "EUR"));
    assert.deepEqual((await db.findShop("cafe-berlin")).merchant?.id, "cafe-berlin");
  });
});
