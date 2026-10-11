// Corridors Phase B (docs/specs/corridors.md §7): the worker settles from the payer's float with the stored route,
// re-quotes with the same `from`, and refunds the card in the charge currency.
// Mock rates: 1.2900 SGD and 0.9259 EUR per USD; S$12.50 from EUR = €8.98 (SendMax €9.07).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, type Quote } from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";
import { handleRefund } from "./refunds";
import { routeFrom, settlePayment } from "./settle";
import { authorizedPayment, createKit, liveMerchant, NO_TEST_DB, testDbAvailable } from "./settle/testkit";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;

const sgd = (a: string) => money(a, "SGD");
const eur = (a: string) => money(a, "EUR");
const mock = createMockSettlement();

describe("routeFrom", () => {
  test("the stored SendMax in the payer's currency; USD falls back to sendMaxUsd; another float → undefined", async () => {
    const q = await mock.quote({ local: sgd("12.50"), from: "EUR" });
    assert.equal(routeFrom(q, "EUR"), "9.07");
    assert.equal(routeFrom(q, "USD"), q.sendMaxUsd);
    assert.equal(routeFrom(q, "SGD"), undefined);
    const legacy = await mock.quote({ local: sgd("12.50") }); // USD-only shape
    assert.equal(routeFrom(legacy, "USD"), legacy.sendMaxUsd);
    assert.equal(routeFrom(legacy, "EUR"), undefined);
  });
});

describe("settle from the payer's currency", { skip }, () => {
  test("EUR payer → SGD shop: one settle from EUR with the stored SendMax, no re-quote", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const quote = await mock.quote({ local: sgd("12.50"), from: "EUR" });
    const p = await authorizedPayment(deps, { quote, charge: eur("8.98") });

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.quote, 0);
    assert.equal(engine.calls.settle.length, 1);
    const call = engine.calls.settle[0]!;
    assert.deepEqual([call.from, call.sendMax, call.local], ["EUR", "9.07", sgd("12.50")]);
    assert.equal((await deps.db.getPayment(p.id))?.status, "settled");
    assert.equal((await deps.db.getBalance("ahseng")).available.amount, "12.50");
  });

  test("path error → fresh quote with the same from (EUR) → retry with its SendMax", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const quote = await mock.quote({ local: sgd("12.50"), from: "EUR" });
    const p = await authorizedPayment(deps, { quote: { ...quote, sendMax: "8.99" }, charge: eur("8.98") });
    engine.settleErrors.push(new Error("tecPATH_PARTIAL"));

    await settlePayment(deps, p.id);

    assert.deepEqual(engine.calls.quotes, [{ local: sgd("12.50"), from: "EUR" }]);
    assert.deepEqual(engine.calls.settle.map((c) => [c.from, c.sendMax]), [
      ["EUR", "8.99"],
      ["EUR", "9.07"],
    ]);
    assert.equal((await deps.db.getPayment(p.id))?.status, "settled");
  });

  test("a stored quote without the EUR route (USD-only) is replaced by quote({ from: EUR }) before the first attempt", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const usdOnly = await mock.quote({ local: sgd("12.50") });
    const p = await authorizedPayment(deps, { quote: usdOnly, charge: eur("8.98") });

    await settlePayment(deps, p.id);

    assert.deepEqual(engine.calls.quotes, [{ local: sgd("12.50"), from: "EUR" }]);
    assert.deepEqual(engine.calls.settle.map((c) => [c.from, c.sendMax]), [["EUR", "9.07"]]);
  });

  test("an expired EUR quote is refreshed (with from EUR) before the first attempt", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const quote = await mock.quote({ local: sgd("12.50"), from: "EUR" });
    const stale: Quote = { ...quote, sendMax: "8.99", expiresAt: new Date(Date.now() - 1000).toISOString() };
    const p = await authorizedPayment(deps, { quote: stale, charge: eur("8.98") });

    await settlePayment(deps, p.id);

    assert.deepEqual(engine.calls.quotes.map((q) => q.from), ["EUR"]);
    assert.equal(engine.calls.settle[0]!.sendMax, "9.07");
  });

  test("USD payer → EUR shop, and EUR payer → EUR shop (direct, no quote needed)", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps, "cafe-berlin", "EUR");
    const usdQuote = await mock.quote({ local: eur("10.10"), from: "USD" });
    const usdPayer = await authorizedPayment(deps, { merchantId: "cafe-berlin", currency: "EUR", local: "10.10", quote: usdQuote, charge: usdQuote.pay! });
    const sameQuote = await mock.quote({ local: eur("4.20"), from: "EUR" });
    const eurPayer = await authorizedPayment(deps, { merchantId: "cafe-berlin", currency: "EUR", local: "4.20", quote: sameQuote, charge: eur("4.20") });

    await settlePayment(deps, usdPayer.id);
    await settlePayment(deps, eurPayer.id);

    assert.equal(engine.calls.quote, 0);
    const byId = new Map(engine.calls.settle.map((c) => [c.paymentId, c]));
    assert.deepEqual([byId.get(usdPayer.id)?.from, byId.get(usdPayer.id)?.sendMax], ["USD", usdQuote.sendMax]);
    assert.deepEqual([byId.get(eurPayer.id)?.from, byId.get(eurPayer.id)?.local], ["EUR", eur("4.20")]);
    const bal = await deps.db.getBalance("cafe-berlin");
    assert.deepEqual(bal.available, eur("14.30"));
  });
});

describe("refunds in the charge currency", { skip }, () => {
  test("an EUR-charged sale at an SGD shop is refunded on the card in EUR (full, then proportional)", async (t) => {
    const { deps, stripe } = await createKit(t);
    await liveMerchant(deps);
    const quote = await mock.quote({ local: sgd("12.50"), from: "EUR" });
    const p = await authorizedPayment(deps, { quote, charge: eur("8.98") });
    await settlePayment(deps, p.id);

    const partial = await handleRefund(deps, { actionId: "act_eur_part", paymentId: p.id, amount: "5.00" });
    assert.equal(partial.status, "completed");
    const full = await handleRefund(deps, { actionId: "act_eur_rest", paymentId: p.id, amount: "7.50" });
    assert.equal(full.status, "completed");

    // €8.98 × 5.00 / 12.50 = 359.2 cents → 359; × 7.50 / 12.50 = 538.8 → 538 (rounded down: never refund more than charged)
    assert.deepEqual(
      stripe.calls.map((c) => c.params.amount),
      [359, 538],
    );
    assert.equal((await deps.db.getPayment(p.id))?.status, "refunded");
  });
});
