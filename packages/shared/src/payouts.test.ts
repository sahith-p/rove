import { test } from "node:test";
import assert from "node:assert/strict";
import { AddBankAccountReq, BankAccountViewZ, InternalCreateMerchantReq } from "./api";
import { currencyLimits, defaultCountryFor, enabledCurrencies, payoutPartnerIdFor } from "./currencies";
import { fixedQrMaxFor, WITHDRAWAL_LIMITS, withdrawalLimitsFor } from "./domain";
import { money } from "./money";
import { bankAccountTypesFor, isValidIban, normalizeIban, routePayoutPartners, type PartnerPayoutStatus } from "./payouts";
import { createMockPayoutPartners, createMockPayoutPartner, createMockSepaPayoutPartner } from "./mocks/payouts.mock";

test("every enabled currency has limits; SGD equals WITHDRAWAL_LIMITS", () => {
  for (const c of enabledCurrencies()) assert.ok(c.limits, `${c.code} has limits`);
  const sgd = withdrawalLimitsFor("SGD");
  assert.deepEqual([sgd.min.amount, sgd.stepUpAbove.amount, sgd.dailyMax.amount], [WITHDRAWAL_LIMITS.minSgd, WITHDRAWAL_LIMITS.stepUpAboveSgd, WITHDRAWAL_LIMITS.dailyMaxSgd]);
  const eur = withdrawalLimitsFor("EUR");
  assert.deepEqual([eur.min, eur.stepUpAbove, eur.dailyMax], [money("1.00", "EUR"), money("150.00", "EUR"), money("1500.00", "EUR")]);
  assert.deepEqual(fixedQrMaxFor("SGD"), money("500.00", "SGD"));
  assert.deepEqual(fixedQrMaxFor("EUR"), money("350.00", "EUR"));
  assert.equal(currencyLimits("USD").fixedQrMax, "400.00");
});

test("defaultCountryFor and payout partners come from the registry", () => {
  assert.equal(defaultCountryFor("SGD"), "SG");
  assert.equal(defaultCountryFor("EUR"), "DE");
  assert.equal(defaultCountryFor("USD"), "US");
  assert.equal(defaultCountryFor("INR"), "IN");
  assert.equal(defaultCountryFor("XXX"), null);
  assert.equal(payoutPartnerIdFor("SGD"), "straitsx");
  assert.equal(payoutPartnerIdFor("EUR"), "sepa");
  assert.equal(payoutPartnerIdFor("USD"), null);
  assert.deepEqual(bankAccountTypesFor("SGD"), ["paynow_uen", "paynow_mobile", "bank_account"]);
  assert.deepEqual(bankAccountTypesFor("EUR"), ["iban"]);
  assert.deepEqual(bankAccountTypesFor("USD"), []);
});

test("IBAN: shape + mod-97 checksum, spaces and case tolerated", () => {
  assert.equal(isValidIban("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(isValidIban("de89370400440532013000"), true);
  assert.equal(isValidIban("FR14 2004 1010 0505 0001 3M02 606"), true);
  assert.equal(isValidIban("DE89 3704 0044 0532 0130 01"), false); // checksum
  assert.equal(isValidIban("1234567890"), false);
  assert.equal(normalizeIban("de89 3704-0044"), "DE8937040044");
});

test("contracts: AddBankAccountReq iban variant, BankAccountView type, optional merchant country", () => {
  const ok = AddBankAccountReq.safeParse({ type: "iban", accountNumber: "DE89 3704 0044 0532 0130 00", holderName: "Café Berlin GmbH" });
  assert.equal(ok.success, true);
  assert.equal(AddBankAccountReq.safeParse({ type: "iban", accountNumber: "DE00 3704 0044 0532 0130 00", holderName: "Café Berlin" }).success, false);
  assert.equal(AddBankAccountReq.safeParse({ type: "bank_account", bankName: "DBS", accountNumber: "0000001234", holderName: "Ah Seng" }).success, true);
  assert.equal(BankAccountViewZ.parse({ id: "b", type: "iban", bankName: null, last4: "3000", holderName: "X", status: "verified", isDefault: true }).type, "iban");
  const base = { id: "cafe-berlin", name: "Café Berlin", phone: "+4915112345678", channel: "whatsapp", currency: "EUR", category: "cafe" };
  assert.equal(InternalCreateMerchantReq.parse(base).country, undefined);
  assert.equal(InternalCreateMerchantReq.parse({ ...base, country: "at" }).country, "AT");
  assert.equal(InternalCreateMerchantReq.safeParse({ ...base, country: "DEU" }).success, false);
});

test("routePayoutPartners: SGD → StraitsX mock (FAST ref), EUR → SEPA mock (SCTINST ref), USD → no partner", async () => {
  const partners = createMockPayoutPartners(5);
  const seen: PartnerPayoutStatus[] = [];
  const off = partners.onUpdate((s) => seen.push(s));

  const sg = await partners.createBeneficiary({ merchantId: "ahseng", type: "paynow_uen", proxy: "201912345K", holderName: "Ah Seng", currency: "SGD" });
  assert.match(sg.beneficiaryId, /^sx_bene_/);
  const eu = await partners.createBeneficiary({ merchantId: "cafe-berlin", type: "iban", accountNumber: "DE89370400440532013000", holderName: "Café Berlin", currency: "EUR" });
  assert.match(eu.beneficiaryId, /^sepa_bene_/);
  assert.equal(eu.last4, "3000");
  assert.equal(eu.resolvedName, "CAFÉ BERLIN");
  await assert.rejects(
    partners.createBeneficiary({ merchantId: "cafe-berlin", type: "paynow_uen", proxy: "201912345K", holderName: "x", currency: "EUR" }),
    /can't receive EUR/,
  );

  const p1 = await partners.createPayout({ withdrawalId: "wd_1", beneficiaryId: sg.beneficiaryId, amount: money("5.00", "SGD"), idempotencyKey: "wd_1" });
  const p2 = await partners.createPayout({ withdrawalId: "wd_2", beneficiaryId: eu.beneficiaryId, amount: money("5.00", "EUR"), idempotencyKey: "wd_2" });
  assert.match(p1.partnerPayoutId, /^sx_po_/);
  assert.match(p2.partnerPayoutId, /^sepa_po_/);
  await assert.rejects(
    partners.createPayout({ withdrawalId: "wd_3", beneficiaryId: "x", amount: money("5.00", "USD"), idempotencyKey: "wd_3" }),
    /no payout partner for USD/,
  );
  await new Promise((r) => setTimeout(r, 30));
  off();
  assert.match((await partners.getPayout(p1.partnerPayoutId)).reference ?? "", /^FAST-\d{6}$/);
  assert.match((await partners.getPayout(p2.partnerPayoutId)).reference ?? "", /^SCTINST-\d{6}$/);
  assert.deepEqual(seen.map((s) => s.withdrawalId).sort(), ["wd_1", "wd_2"]);

  // getPayout for an id this router didn't create asks each partner in turn
  const sepa = createMockSepaPayoutPartner(5);
  const direct = await sepa.createPayout({ withdrawalId: "wd_4", beneficiaryId: "b", amount: money("1.00", "EUR"), idempotencyKey: "wd_4" });
  const router = routePayoutPartners({ straitsx: createMockPayoutPartner(5), sepa });
  assert.equal((await router.getPayout(direct.partnerPayoutId)).withdrawalId, "wd_4");
  await assert.rejects(router.getPayout("nope"), /unknown payout/);
});
