import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "@rove/shared";
import type { TransactionMetadata } from "xrpl";
import { currencyHex } from "./currency";
import { XrplTxError } from "./errors";
import { ammInputForOutput, buildQuote, QUOTE_TTL_MS } from "./quote";
import { deliveredSgd, toSettleResult } from "./settle";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

test("buildQuote: usd rounds UP to cents, sendMax = usd × 1.01 rounded up, rate = local/usd, 60s expiry", () => {
  // The real testnet path for S$12.50 on a fresh 10,000/12,900 pool with TradingFee 30.
  const q = buildQuote(money("12.50", "SGD"), "9.702231717041783", NOW);
  assert.deepEqual(q, {
    local: { amount: "12.50", currency: "SGD" },
    usd: { amount: "9.71", currency: "USD" },
    rate: "1.2873",
    sendMaxUsd: "9.81", // 9.71 × 1.01 = 9.8071 → 9.81
    expiresAt: new Date(NOW + QUOTE_TTL_MS).toISOString(),
  });
});

test("buildQuote: exact cents are not rounded up; tiny remainders are", () => {
  assert.equal(buildQuote(money("12.90", "SGD"), "10.00", NOW).usd.amount, "10.00");
  assert.equal(buildQuote(money("12.90", "SGD"), "10.000000000001", NOW).usd.amount, "10.01");
  assert.equal(buildQuote(money("12.90", "SGD"), "1000e-2", NOW).usd.amount, "10.00");
  assert.equal(buildQuote(money("12.90", "SGD"), "10.00", NOW).sendMaxUsd, "10.10");
  assert.equal(buildQuote(money("1.00", "SGD"), "0.7752", NOW).sendMaxUsd, "0.79"); // 0.78 × 1.01 = 0.7878 → 0.79
});

test("buildQuote: rate is floored to 4 decimals", () => {
  assert.equal(buildQuote(money("6.50", "SGD"), "5.04", NOW).rate, "1.2896"); // 650/504 = 1.28968…
});

test("buildQuote rejects non-SGD, zero and negative inputs", () => {
  assert.throws(() => buildQuote(money("1.00", "USD"), "1", NOW));
  assert.throws(() => buildQuote(money("0.00", "SGD"), "1", NOW));
  assert.throws(() => buildQuote(money("1.00", "SGD"), "-1", NOW));
  assert.throws(() => buildQuote(money("1.00", "SGD"), "0", NOW));
});

test("ammInputForOutput matches XLS-30 constant product (and rippled's path_find)", () => {
  const v = ammInputForOutput({ poolIn: "10000", poolOut: "12900", out: "12.50", tradingFee: 30 });
  // rippled ripple_path_find on testnet said 9.702231717041783
  assert.ok(v.startsWith("9.70223171704178"), v);
  assert.equal(buildQuote(money("12.50", "SGD"), v, NOW).usd.amount, "9.71");
  // no fee: 10000·12.9/(12900−12.9) = 10.01001…
  assert.ok(ammInputForOutput({ poolIn: "10000", poolOut: "12900", out: "12.90", tradingFee: 0 }).startsWith("10.01001001001"));
  assert.throws(() => ammInputForOutput({ poolIn: "10", poolOut: "10", out: "10", tradingFee: 30 }));
  assert.throws(() => ammInputForOutput({ poolIn: "10", poolOut: "10", out: "0", tradingFee: 30 }));
});

const SGD = { currency: currencyHex("XSGD"), issuer: "rSgdIssuer" };
const meta = (delivered: unknown) => ({ TransactionResult: "tesSUCCESS", AffectedNodes: [], TransactionIndex: 0, delivered_amount: delivered }) as unknown as TransactionMetadata;

test("deliveredSgd normalises delivered_amount with money()", () => {
  assert.deepEqual(deliveredSgd(meta({ ...SGD, value: "12.5" }), SGD), { amount: "12.50", currency: "SGD" });
  assert.deepEqual(deliveredSgd(meta({ ...SGD, value: "1250e-2" }), SGD), { amount: "12.50", currency: "SGD" });
});

test("deliveredSgd rejects other assets, XRP, missing and sub-cent amounts", () => {
  assert.throws(() => deliveredSgd(meta({ ...SGD, issuer: "rOther", value: "12.5" }), SGD), XrplTxError);
  assert.throws(() => deliveredSgd(meta("12500000"), SGD), XrplTxError);
  assert.throws(() => deliveredSgd(meta(undefined), SGD), XrplTxError);
  assert.throws(() => deliveredSgd(meta({ ...SGD, value: "12.499999" }), SGD), /whole number of cents/);
});

test("toSettleResult: success only when delivered == local", () => {
  const outcome = { hash: "ABC", ledgerIndex: 7, result: "tesSUCCESS", meta: meta({ ...SGD, value: "12.5" }), tx: {} };
  assert.deepEqual(toSettleResult(outcome, money("12.50", "SGD"), SGD), { txHash: "ABC", delivered: "12.50", ledgerIndex: 7 });
  assert.throws(() => toSettleResult(outcome, money("12.51", "SGD"), SGD), /DELIVERED|expected 12.51/);
});
