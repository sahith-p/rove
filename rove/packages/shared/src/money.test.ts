import { test } from "node:test";
import assert from "node:assert/strict";
import { add, cmp, format, money, sub, toUnits, fromUnits } from "./money";

test("parses and formats decimals without floats", () => {
  assert.equal(money("6.5", "SGD").amount, "6.50");
  assert.equal(format(money("6.50", "SGD")), "S$6.50");
  assert.equal(add(money("0.10", "SGD"), money("0.20", "SGD")).amount, "0.30");
  assert.equal(sub(money("6.50", "SGD"), money("6.50", "SGD")).amount, "0.00");
});

test("rounding modes", () => {
  assert.equal(toUnits("5.0384", 2, "ceil"), 504n);
  assert.equal(toUnits("5.0384", 2, "floor"), 503n);
  assert.throws(() => toUnits("5.0384", 2, "exact"));
  assert.equal(fromUnits(504n, 2), "5.04");
});

test("refuses currency mixing", () => {
  assert.throws(() => cmp(money("1", "SGD"), money("1", "USD")));
});
