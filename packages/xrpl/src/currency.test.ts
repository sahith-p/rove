import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialTypeHex,
  currencyFromHex,
  currencyHex,
  issued,
  plainDecimal,
  sameCurrency,
  SGD_CODE,
  USD_CODE,
} from "./currency";

test("currencyHex: codes longer than 3 chars become 40-hex, upper-case, zero-padded", () => {
  assert.equal(currencyHex("XSGD"), "5853474400000000000000000000000000000000");
  assert.equal(currencyHex("RLUSD"), "524C555344000000000000000000000000000000");
  assert.equal(currencyHex(SGD_CODE).length, 40);
  assert.equal(currencyHex(USD_CODE), currencyHex("RLUSD"));
});

test("currencyHex: 3-char codes pass through; hex passes through upper-cased", () => {
  assert.equal(currencyHex("USD"), "USD");
  assert.equal(currencyHex("5853474400000000000000000000000000000000".toLowerCase()), "5853474400000000000000000000000000000000");
});

test("currencyHex: rejects XRP, too short, too long", () => {
  assert.throws(() => currencyHex("XRP"));
  assert.throws(() => currencyHex("AB"));
  assert.throws(() => currencyHex("A".repeat(21)));
});

test("currencyFromHex round-trips", () => {
  assert.equal(currencyFromHex(currencyHex("XSGD")), "XSGD");
  assert.equal(currencyFromHex(currencyHex("RLUSD")), "RLUSD");
  assert.equal(currencyFromHex("USD"), "USD");
  assert.ok(sameCurrency("XSGD", "5853474400000000000000000000000000000000"));
  assert.ok(!sameCurrency("XSGD", "RLUSD"));
});

test("credentialTypeHex is the UTF-8 hex of the name", () => {
  assert.equal(credentialTypeHex("ROVE_VERIFIED_MERCHANT"), Buffer.from("ROVE_VERIFIED_MERCHANT").toString("hex").toUpperCase());
  assert.equal(credentialTypeHex("AB"), "4142");
});

test("issued() hex-encodes the code", () => {
  assert.deepEqual(issued("XSGD", "rIssuer", "12.50"), {
    currency: "5853474400000000000000000000000000000000",
    issuer: "rIssuer",
    value: "12.50",
  });
});

test("plainDecimal normalises rippled value formats", () => {
  assert.equal(plainDecimal("12.5"), "12.5");
  assert.equal(plainDecimal("12.50"), "12.5");
  assert.equal(plainDecimal("1250e-2"), "12.5");
  assert.equal(plainDecimal("1.25E1"), "12.5");
  assert.equal(plainDecimal("1e-7"), "0.0000001");
  assert.equal(plainDecimal("0.05"), "0.05");
  assert.equal(plainDecimal("1.5e3"), "1500");
  assert.equal(plainDecimal("100"), "100");
  assert.equal(plainDecimal("10.00"), "10");
  assert.equal(plainDecimal("-9.7234"), "-9.7234");
  assert.equal(plainDecimal("0"), "0");
  assert.equal(plainDecimal("-0.0"), "0");
  assert.equal(plainDecimal("9.720349127332198"), "9.720349127332198");
  assert.throws(() => plainDecimal("abc"));
  assert.throws(() => plainDecimal(""));
});
