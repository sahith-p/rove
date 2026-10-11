import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allCurrencies,
  CURRENCY_CODES,
  currencyForCountry,
  currencyForPhone,
  currencyInfo,
  enabledCurrencies,
  getCurrency,
  HUB_CURRENCY,
  isCurrency,
  isMerchantCurrency,
  payerCurrencyFor,
} from "./currencies";
import { CurrencyZ, InternalCreateMerchantReq, QuoteZ, UpdateShopReq } from "./api";
import { DECIMALS, format, money, toMinor } from "./money";
import { createMockSettlement } from "./mocks/settlement.mock";

test("enabled currencies: SGD, USD, EUR, each with a live testnet stablecoin", () => {
  assert.deepEqual([...CURRENCY_CODES], ["SGD", "USD", "EUR"]);
  assert.deepEqual(
    enabledCurrencies().map((c) => [c.code, c.stablecoin?.xrplCode, c.stablecoin?.issuerEnv]),
    [
      ["SGD", "XSGD", "XRPL_SGD_ISSUER"],
      ["USD", "RLUSD", "XRPL_USD_ISSUER"],
      ["EUR", "EUR", "XRPL_ISSUER_EUR"],
    ],
  );
  assert.equal(HUB_CURRENCY, "USD");
  for (const c of enabledCurrencies()) assert.equal(c.stablecoin?.status, "live-on-testnet");
});

test("planned entries are listed but not enabled (INR has no stablecoin)", () => {
  const planned = allCurrencies().filter((c) => !isCurrency(c.code));
  assert.ok(planned.length >= 1);
  const inr = getCurrency("inr");
  assert.equal(inr?.stablecoin, null);
  assert.deepEqual(inr?.payerRails, ["upi"]);
  for (const c of planned) assert.notEqual(c.stablecoin?.status, "live-on-testnet");
  assert.equal(isMerchantCurrency("INR"), false);
  assert.equal(isMerchantCurrency("EUR"), true);
  assert.equal(isCurrency("eur"), false); // exact case only
  assert.throws(() => currencyInfo("INR" as never));
});

test("every entry is well-formed: unique codes, unique phone prefixes, ISO-ish shapes", () => {
  const codes = allCurrencies().map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  const prefixes = allCurrencies().flatMap((c) => c.phonePrefixes);
  assert.equal(new Set(prefixes).size, prefixes.length, "a phone prefix belongs to one currency");
  for (const c of allCurrencies()) {
    assert.match(c.code, /^[A-Z]{3}$/);
    assert.ok(Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 6);
    for (const cc of c.countries) assert.match(cc, /^[A-Z]{2}$/);
    for (const p of c.phonePrefixes) assert.match(p, /^[1-9]\d{0,2}$/);
    assert.ok(c.payerRails.length > 0);
  }
});

test("currencyForPhone: longest E.164 country code wins", () => {
  assert.equal(currencyForPhone("+6591234567")?.code, "SGD");
  assert.equal(currencyForPhone("+14155550123")?.code, "USD");
  assert.equal(currencyForPhone("+4915112345678")?.code, "EUR"); // Germany
  assert.equal(currencyForPhone("+33612345678")?.code, "EUR"); // France
  assert.equal(currencyForPhone("+35312345678")?.code, "EUR"); // Ireland (353, not 35x)
  assert.equal(currencyForPhone("+35912345678")?.code, "EUR"); // Bulgaria (euro since 2026)
  assert.equal(currencyForPhone("+919876543210")?.code, "INR");
  assert.equal(currencyForPhone("+61412345678")?.code, "AUD");
  assert.equal(currencyForPhone("+65 9123 4567")?.code, "SGD"); // formatting tolerated
  assert.equal(currencyForPhone("+447700900123"), null); // UK: not in the registry
  assert.equal(currencyForPhone("not a phone"), null);
});

test("currencyForCountry", () => {
  assert.equal(currencyForCountry("SG")?.code, "SGD");
  assert.equal(currencyForCountry("de")?.code, "EUR");
  assert.equal(currencyForCountry("US")?.code, "USD");
  assert.equal(currencyForCountry("IN")?.code, "INR");
  assert.equal(currencyForCountry("GB"), null);
});

test("payerCurrencyFor: explicit choice, then phone, then country, else USD; planned currencies fall back to USD", () => {
  assert.equal(payerCurrencyFor({ requested: "EUR", phone: "+6591234567" }), "EUR");
  assert.equal(payerCurrencyFor({ requested: "INR", phone: "+6591234567" }), "SGD");
  assert.equal(payerCurrencyFor({ phone: "+4915112345678" }), "EUR");
  assert.equal(payerCurrencyFor({ phone: "+919876543210" }), "USD");
  assert.equal(payerCurrencyFor({ country: "FR" }), "EUR");
  assert.equal(payerCurrencyFor({}), "USD");
});

test("decimals and symbols come from the registry; SGD/USD unchanged", () => {
  assert.deepEqual(DECIMALS, { SGD: 2, USD: 2, EUR: 2 });
  assert.equal(format(money("6.50", "SGD")), "S$6.50");
  assert.equal(format(money("9.72", "USD")), "US$9.72");
  assert.equal(format(money("9", "EUR")), "€9.00");
  assert.equal(toMinor(money("12.34", "EUR")), 1234n);
  assert.throws(() => money("1.234", "EUR"));
});

test("contracts accept every enabled currency (and only those)", () => {
  assert.equal(CurrencyZ.parse("EUR"), "EUR");
  assert.equal(CurrencyZ.safeParse("INR").success, false);
  const merchant = { id: "cafe-berlin", name: "Café Berlin", phone: "+4915112345678", channel: "whatsapp", category: "cafe" };
  assert.equal(InternalCreateMerchantReq.parse({ ...merchant, currency: "EUR" }).currency, "EUR");
  assert.equal(InternalCreateMerchantReq.parse({ ...merchant, currency: "SGD" }).currency, "SGD");
  assert.equal(InternalCreateMerchantReq.safeParse({ ...merchant, currency: "INR" }).success, false);
  assert.equal(UpdateShopReq.parse({ currency: "EUR" }).currency, "EUR");
  const q = { local: { amount: "12.50", currency: "SGD" }, usd: { amount: "9.71", currency: "USD" }, rate: "1.2873", sendMaxUsd: "9.81", expiresAt: "x" };
  assert.deepEqual(QuoteZ.parse(q), q); // old shape still valid
  const withPay = { ...q, rate: "1.3888", pay: { amount: "9.00", currency: "EUR" }, sendMax: "9.09" };
  assert.deepEqual(QuoteZ.parse(withPay), withPay); // new optional fields survive parsing
});

test("mock engine: no `from` → the original USD quote shape; any pair with `from`", async () => {
  const m = createMockSettlement();
  assert.deepEqual(Object.keys(await m.quote({ local: money("12.90", "SGD") })).sort(), ["expiresAt", "local", "rate", "sendMaxUsd", "usd"]);
  const q = await m.quote({ local: money("12.90", "SGD") });
  assert.deepEqual([q.usd.amount, q.rate, q.sendMaxUsd], ["10.00", "1.2900", "10.10"]);
  const eur = await m.quote({ local: money("12.90", "SGD"), from: "EUR" });
  assert.deepEqual([eur.usd.amount, eur.pay, eur.sendMax, eur.rate], ["10.00", { amount: "9.26", currency: "EUR" }, "9.36", "1.3932"]);
  const same = await m.quote({ local: money("5.00", "EUR"), from: "EUR" });
  assert.deepEqual([same.pay?.amount, same.sendMax, same.rate], ["5.00", "5.00", "1.0000"]);
  const addr = (await m.createMerchantAccount({ merchantId: "cafe-berlin", currency: "EUR" })).xrplAddress;
  assert.deepEqual(await m.balance({ merchantAddress: addr }), { amount: "0.00", currency: "EUR" });
});
