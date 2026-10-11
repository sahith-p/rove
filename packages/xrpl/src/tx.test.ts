import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { issued } from "./currency";
import {
  ASF_DEFAULT_RIPPLE,
  buildAmmCreate,
  buildCredentialAccept,
  buildCredentialCreate,
  buildCrossCurrencyPayment,
  buildDefaultRipple,
  buildIouPayment,
  buildTrustSet,
  buildXrpPayment,
  DEFAULT_TRUST_LIMIT,
  invoiceIdFor,
  TF_PARTIAL_PAYMENT,
} from "./tx";

const TREASURY = "rTreasuryXXXXXXXXXXXXXXXXXXXXXXXX";
const MERCHANT = "rMerchantXXXXXXXXXXXXXXXXXXXXXXXX";
const REDEMPTION = "rRedemptionXXXXXXXXXXXXXXXXXXXXXX";
const USD_ISSUER = "rUsdIssuerXXXXXXXXXXXXXXXXXXXXXXX";
const SGD_ISSUER = "rSgdIssuerXXXXXXXXXXXXXXXXXXXXXXX";
const XSGD_HEX = "5853474400000000000000000000000000000000";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

test("invoiceIdFor = sha256(id) as 64 upper-case hex", () => {
  const id = "pay_0123456789abcdef";
  const want = createHash("sha256").update(id).digest("hex").toUpperCase();
  assert.equal(invoiceIdFor(id), want);
  assert.match(invoiceIdFor("wd_anything"), /^[0-9A-F]{64}$/);
  assert.notEqual(invoiceIdFor("pay_a"), invoiceIdFor("pay_b"));
  assert.throws(() => invoiceIdFor(""));
});

test("settlement Payment: exact XSGD Amount, RLUSD SendMax, InvoiceID, Paths, no partial-payment flag", () => {
  const paths = [[{ currency: XSGD_HEX, issuer: SGD_ISSUER }]];
  const tx = buildCrossCurrencyPayment({
    account: TREASURY,
    destination: MERCHANT,
    amount: issued("XSGD", SGD_ISSUER, "12.50"),
    sendMax: issued("RLUSD", USD_ISSUER, "9.79"),
    invoiceId: invoiceIdFor("pay_1"),
    paths,
  });
  assert.deepEqual(tx, {
    TransactionType: "Payment",
    Account: TREASURY,
    Destination: MERCHANT,
    Amount: { currency: XSGD_HEX, issuer: SGD_ISSUER, value: "12.50" },
    SendMax: { currency: RLUSD_HEX, issuer: USD_ISSUER, value: "9.79" },
    InvoiceID: invoiceIdFor("pay_1"),
    Paths: paths,
  });
  assert.equal(((tx.Flags as number | undefined) ?? 0) & TF_PARTIAL_PAYMENT, 0);
});

test("settlement Payment omits empty Paths and refuses same-asset SendMax", () => {
  const tx = buildCrossCurrencyPayment({
    account: TREASURY,
    destination: MERCHANT,
    amount: issued("XSGD", SGD_ISSUER, "1.00"),
    sendMax: issued("RLUSD", USD_ISSUER, "1.00"),
    paths: [],
  });
  assert.equal("Paths" in tx, false);
  assert.equal("InvoiceID" in tx, false);
  assert.throws(() =>
    buildCrossCurrencyPayment({
      account: TREASURY,
      destination: MERCHANT,
      amount: issued("XSGD", SGD_ISSUER, "1.00"),
      sendMax: issued("XSGD", SGD_ISSUER, "1.00"),
    }),
  );
});

test("same-currency XSGD Payment (SGD float settle / refund / sweep): no SendMax, no Paths", () => {
  const tx = buildIouPayment({ account: TREASURY, destination: MERCHANT, amount: issued("XSGD", SGD_ISSUER, "12.50"), invoiceId: invoiceIdFor("pay_2") });
  assert.deepEqual(tx, {
    TransactionType: "Payment",
    Account: TREASURY,
    Destination: MERCHANT,
    Amount: { currency: XSGD_HEX, issuer: SGD_ISSUER, value: "12.50" },
    InvoiceID: invoiceIdFor("pay_2"),
  });
  assert.throws(() => buildIouPayment({ account: MERCHANT, destination: MERCHANT, amount: issued("XSGD", SGD_ISSUER, "1") }));
});

test("sweep to redemption: merchant → REDEMPTION XSGD with InvoiceID = sha256(withdrawalId)", () => {
  const wd = "wd_9f8e7d";
  const tx = buildIouPayment({ account: MERCHANT, destination: REDEMPTION, amount: issued("XSGD", SGD_ISSUER, "118.40"), invoiceId: invoiceIdFor(wd) });
  assert.equal(tx.Account, MERCHANT);
  assert.equal(tx.Destination, REDEMPTION);
  assert.deepEqual(tx.Amount, { currency: XSGD_HEX, issuer: SGD_ISSUER, value: "118.40" });
  assert.equal(tx.InvoiceID, createHash("sha256").update(wd).digest("hex").toUpperCase());
  assert.equal(tx.SendMax, undefined);
});

test("XRP funding Payment uses drops", () => {
  assert.deepEqual(buildXrpPayment({ account: TREASURY, destination: MERCHANT, drops: "3000000" }), {
    TransactionType: "Payment",
    Account: TREASURY,
    Destination: MERCHANT,
    Amount: "3000000",
  });
  assert.throws(() => buildXrpPayment({ account: TREASURY, destination: MERCHANT, drops: "3.5" }));
  assert.throws(() => buildXrpPayment({ account: TREASURY, destination: MERCHANT, drops: "0" }));
});

test("TrustSet to an issuer", () => {
  assert.deepEqual(buildTrustSet({ account: MERCHANT, currency: XSGD_HEX, issuer: SGD_ISSUER }), {
    TransactionType: "TrustSet",
    Account: MERCHANT,
    LimitAmount: { currency: XSGD_HEX, issuer: SGD_ISSUER, value: DEFAULT_TRUST_LIMIT },
  });
  assert.equal(buildTrustSet({ account: MERCHANT, currency: XSGD_HEX, issuer: SGD_ISSUER, limit: "500" }).LimitAmount.value, "500");
});

test("AccountSet asfDefaultRipple", () => {
  assert.deepEqual(buildDefaultRipple(SGD_ISSUER), { TransactionType: "AccountSet", Account: SGD_ISSUER, SetFlag: ASF_DEFAULT_RIPPLE });
  assert.equal(ASF_DEFAULT_RIPPLE, 8);
});

test("AMMCreate 10,000 RLUSD / 12,900 XSGD, TradingFee 30", () => {
  const tx = buildAmmCreate({
    account: "rLP",
    amount: issued("RLUSD", USD_ISSUER, "10000"),
    amount2: issued("XSGD", SGD_ISSUER, "12900"),
    tradingFee: 30,
  });
  assert.deepEqual(tx, {
    TransactionType: "AMMCreate",
    Account: "rLP",
    Amount: { currency: RLUSD_HEX, issuer: USD_ISSUER, value: "10000" },
    Amount2: { currency: XSGD_HEX, issuer: SGD_ISSUER, value: "12900" },
    TradingFee: 30,
  });
  assert.throws(() => buildAmmCreate({ account: "rLP", amount: issued("RLUSD", USD_ISSUER, "1"), amount2: issued("XSGD", SGD_ISSUER, "1"), tradingFee: 1001 }));
  assert.throws(() => buildAmmCreate({ account: "rLP", amount: issued("RLUSD", USD_ISSUER, "1"), amount2: issued("XSGD", SGD_ISSUER, "1"), tradingFee: 0.5 }));
});

test("CredentialCreate (issuer → subject) and CredentialAccept (subject) use the hex credential type", () => {
  const typeHex = Buffer.from("ROVE_VERIFIED_MERCHANT").toString("hex").toUpperCase();
  assert.deepEqual(buildCredentialCreate({ issuer: "rCred", subject: MERCHANT, credentialType: "ROVE_VERIFIED_MERCHANT" }), {
    TransactionType: "CredentialCreate",
    Account: "rCred",
    Subject: MERCHANT,
    CredentialType: typeHex,
  });
  assert.deepEqual(buildCredentialAccept({ subject: MERCHANT, issuer: "rCred", credentialType: "ROVE_VERIFIED_MERCHANT" }), {
    TransactionType: "CredentialAccept",
    Account: MERCHANT,
    Issuer: "rCred",
    CredentialType: typeHex,
  });
});
