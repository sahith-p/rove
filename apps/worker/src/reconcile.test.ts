// NI-C7 · reconciler: ledger available + held vs the merchant's XSGD on XRPL, on PGlite with a scripted engine.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, toMinor, type SettlementEngine } from "@rove/shared";
import { createServer } from "./server";
import { describeResult, reconcileAll, reconcileMerchant, reconcileSnapshot, startReconciler } from "./reconcile";
import { createKit, liveMerchant, NO_TEST_DB, testDbAvailable } from "./settle/testkit";
import { TEST_CONFIG, TEST_INTERNAL_SECRET } from "./testing";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;
const FAST = { confirmDelayMs: 0 };
const sgd = (a: string) => money(a, "SGD");

/** An engine whose balance() answers from a per-address script (last value repeats), or throws. */
function balanceEngine(base: SettlementEngine, script: Record<string, (string | Error)[]>) {
  const calls: string[] = [];
  const engine: SettlementEngine = {
    ...base,
    async balance({ merchantAddress }) {
      calls.push(merchantAddress);
      const steps = script[merchantAddress] ?? ["0.00"];
      const i = calls.filter((a) => a === merchantAddress).length - 1;
      const step = steps[Math.min(i, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return sgd(step);
    },
  };
  return { engine, calls };
}

describe("reconcileMerchant", { skip }, () => {
  test("ledger == XRPL → ok, one readable ✓ line", async (t) => {
    const kit = await createKit(t);
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("12.50"), ref: "pay_a" });
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("12.50"), ref: "pay_b" });
    kit.engine.balances.set(m.xrplAddress!, toMinor(sgd("25.00")));

    const r = await reconcileMerchant(kit.deps, m.id, FAST);

    assert.equal(r.ok, true);
    assert.equal(r.status, "ok");
    assert.deepEqual([r.ledger, r.onchain, r.diff], [sgd("25.00"), sgd("25.00"), "0.00"]);
    assert.equal(r.xrplAddress, m.xrplAddress);
    const lines = kit.logs.filter((l) => l.includes("[test:reconcile]"));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /INFO .*ahseng\s+ledger S\$25\.00 = XRPL S\$25\.00 ✓$/);
  });

  test("held funds count: available + held must equal XRPL while a withdrawal is approved", async (t) => {
    const kit = await createKit(t);
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("20.00"), ref: "pay_a" });
    const wd = await kit.deps.db.insertWithdrawal({
      merchantId: m.id,
      amount: sgd("5.00"),
      fee: sgd("0.00"),
      destination: { kind: "xrpl_wallet", address: "rWALLET" },
      needsStepUp: false,
    });
    assert.equal((await kit.deps.db.approveWithdrawal(wd.id, "act_1")).ok, true);
    kit.engine.balances.set(m.xrplAddress!, toMinor(sgd("20.00"))); // nothing left the account yet

    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.ok, true);
    assert.deepEqual([r.available, r.held, r.ledger], [sgd("15.00"), sgd("5.00"), sgd("20.00")]);
  });

  test("XRPL ≠ ledger → DRIFT line with the difference; nothing is changed", async (t) => {
    const kit = await createKit(t, { config: { ...TEST_CONFIG, useMockSettlement: false } });
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("25.00"), ref: "pay_a" });
    kit.engine.balances.set(m.xrplAddress!, toMinor(sgd("20.00")));

    const r = await reconcileMerchant(kit.deps, m.id, FAST);

    assert.equal(r.ok, false);
    assert.equal(r.status, "drift");
    assert.equal(r.diff, "-5.00");
    assert.equal(r.inFlight, 0);
    const line = kit.logs.find((l) => l.includes("DRIFT"))!;
    assert.match(line, /ERROR .*DRIFT ahseng\s+ledger S\$25\.00 ≠ XRPL S\$20\.00 · XRPL holds S\$5\.00 less than the ledger/);
    assert.match(line, /not auto-fixed/);
    // Not "fixed": the ledger and the engine are untouched.
    assert.deepEqual((await kit.deps.db.getBalance(m.id)).available, sgd("25.00"));
    assert.equal(kit.engine.calls.settle.length + kit.engine.calls.refund.length, 0);
  });

  test("XRPL holding more than the ledger (XSGD with no matching payment) is drift too", async (t) => {
    const kit = await createKit(t, { config: { ...TEST_CONFIG, useMockSettlement: false } });
    const m = await liveMerchant(kit.deps);
    kit.engine.balances.set(m.xrplAddress!, toMinor(sgd("25.00")));
    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.status, "drift");
    assert.equal(r.diff, "25.00");
    assert.ok(kit.logs.some((l) => l.includes("XRPL holds S$25.00 more than the ledger")));
  });

  test("a mismatch that resolves on the re-read (a settlement landing between reads) is not drift", async (t) => {
    const kit = await createKit(t);
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("12.50"), ref: "pay_a" });
    // First read: XRPL already has the next sale; by the re-read its ledger entry has landed too.
    const { engine, calls } = balanceEngine(kit.engine.engine, { [m.xrplAddress!]: ["18.00", "18.00"] });
    kit.deps.settlement = engine;
    const slowLedger = kit.deps.db.getBalance.bind(kit.deps.db);
    let reads = 0;
    kit.deps.db.getBalance = async (id) => {
      if (++reads === 2) await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("5.50"), ref: "pay_b" });
      return slowLedger(id);
    };

    const r = await reconcileMerchant(kit.deps, m.id, FAST);

    assert.equal(r.ok, true, describeResult(r));
    assert.equal(calls.length, 2, "XRPL read twice");
    assert.ok(!kit.logs.some((l) => l.includes("DRIFT")));
  });

  test("drift while a payment is settling says so", async (t) => {
    const kit = await createKit(t, { config: { ...TEST_CONFIG, useMockSettlement: false } });
    const m = await liveMerchant(kit.deps);
    const p = await kit.deps.db.insertPayment({
      id: "pay_inflight",
      merchantId: m.id,
      source: "fixed_qr",
      invoiceId: null,
      lines: [],
      local: sgd("12.50"),
      quote: null,
      charge: money("9.70", "USD"),
      method: "card",
      payer: null,
    });
    await kit.deps.db.transitionPayment(p.id, ["created"], "authorized");
    await kit.deps.db.transitionPayment(p.id, ["authorized"], "settling");
    kit.engine.balances.set(m.xrplAddress!, toMinor(sgd("12.50")));

    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.status, "drift");
    assert.equal(r.inFlight, 1);
    assert.ok(kit.logs.some((l) => l.includes("1 payment/withdrawal step(s) in flight")));
  });

  test("mock engine: drift is a warning (its balances reset on restart), not an alarm", async (t) => {
    const kit = await createKit(t); // TEST_CONFIG.useMockSettlement = true
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("5.00"), ref: "pay_a" });
    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.status, "drift");
    const line = kit.logs.find((l) => l.includes("DRIFT"))!;
    assert.match(line, /WARN .*mock engine/);
  });

  test("XRPL unreachable → status error (not drift), logged as a warning", async (t) => {
    const kit = await createKit(t);
    const m = await liveMerchant(kit.deps);
    kit.deps.settlement = balanceEngine(kit.engine.engine, { [m.xrplAddress!]: [new Error("websocket closed")] }).engine;
    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.status, "error");
    assert.equal(r.ok, false);
    assert.equal(r.onchain, null);
    assert.match(r.error!, /couldn't read XRPL: websocket closed/);
    assert.ok(kit.logs.some((l) => /WARN .*ahseng\s+ledger S\$0\.00 vs XRPL \?/.test(l)));
  });

  test("unknown merchant / no XRPL account → error result, never throws", async (t) => {
    const kit = await createKit(t);
    assert.equal((await reconcileMerchant(kit.deps, "ghost", FAST)).error, "no such merchant");
    await kit.deps.db.upsertDraftMerchant({ id: "draftco", name: "Draft Co", phone: "+15555550777", channel: "imessage" });
    assert.equal((await reconcileMerchant(kit.deps, "draftco", FAST)).error, "merchant has no XRPL account yet");
  });

  test("compares to the cent: sub-cent differences can't exist (money.ts minor units)", async (t) => {
    const kit = await createKit(t, { config: { ...TEST_CONFIG, useMockSettlement: false } });
    const m = await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: m.id, kind: "payment_credit", amount: sgd("0.01"), ref: "pay_a" });
    kit.engine.balances.set(m.xrplAddress!, 0n);
    const r = await reconcileMerchant(kit.deps, m.id, FAST);
    assert.equal(r.status, "drift");
    assert.equal(r.diff, "-0.01");
  });
});

describe("reconcileAll + GET /internal/reconcile", { skip }, () => {
  test("checks every live merchant with an XRPL account; the endpoint serves the last results behind the bearer token", async (t) => {
    const kit = await createKit(t, { config: { ...TEST_CONFIG, useMockSettlement: false } });
    const a = await liveMerchant(kit.deps, "ahseng");
    const b = await liveMerchant(kit.deps, "kopi");
    await kit.deps.db.upsertDraftMerchant({ id: "draftco", name: "Draft Co", phone: "+15555550778", channel: "imessage" });
    await kit.deps.db.appendLedger({ merchantId: a.id, kind: "payment_credit", amount: sgd("12.50"), ref: "pay_a" });
    kit.engine.balances.set(a.xrplAddress!, toMinor(sgd("12.50")));
    kit.engine.balances.set(b.xrplAddress!, toMinor(sgd("1.00")));

    const server = createServer(kit.deps);
    const before = (await (await server.request("/internal/reconcile", { headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}` } })).json()) as ReturnType<
      typeof reconcileSnapshot
    >;
    assert.deepEqual(before.merchants, []);
    assert.equal(before.lastRunAt, null);
    assert.equal(before.ok, false);

    const results = await reconcileAll(kit.deps, FAST);
    assert.deepEqual(
      results.map((r) => [r.merchantId, r.status]),
      [
        ["ahseng", "ok"],
        ["kopi", "drift"],
      ],
    );

    assert.equal((await server.request("/internal/reconcile")).status, 401);
    const res = await server.request("/internal/reconcile", { headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as ReturnType<typeof reconcileSnapshot>;
    assert.equal(body.engine, "real");
    assert.equal(body.ok, false);
    assert.ok(body.lastRunAt);
    assert.deepEqual(
      body.merchants.map((r) => [r.merchantId, r.ok, r.ledger.amount, r.onchain?.amount, r.diff]),
      [
        ["ahseng", true, "12.50", "12.50", "0.00"],
        ["kopi", false, "0.00", "1.00", "1.00"],
      ],
    );
    // Reading the endpoint doesn't run a check.
    const again = (await (await server.request("/internal/reconcile", { headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}` } })).json()) as typeof body;
    assert.equal(again.lastRunAt, body.lastRunAt);
  });

  test("startReconciler runs a pass right away and on its interval; the stopper stops it", async (t) => {
    const kit = await createKit(t);
    const m = await liveMerchant(kit.deps);
    const { engine, calls } = balanceEngine(kit.engine.engine, { [m.xrplAddress!]: ["0.00"] });
    kit.deps.settlement = engine;
    const stop = startReconciler(kit.deps, FAST); // TEST_CONFIG interval: 50ms
    await new Promise((r) => setTimeout(r, 180));
    stop();
    const n = calls.length;
    assert.ok(n >= 2, `expected ≥ 2 passes, got ${n}`);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls.length, n, "no passes after stop");
    assert.equal(reconcileSnapshot(kit.deps).ok, true);
  });
});
