// NI-C7 · boot(): withdrawal resume + undelivered-event replay + summary line, and the demo laptop's money log.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, type EventEnvelope, type RoveEvent } from "@rove/shared";
import { boot, describeBoot, installMoneyLog, moneyLine, REPLAY_GIVE_UP_AFTER, RESUMABLE_WITHDRAWAL_STATUSES } from "./boot";
import { createLogger } from "./log";
import { createKit, liveMerchant, NO_TEST_DB, testDbAvailable } from "./settle/testkit";
import { createFakeDb } from "./test-fakes";
import { createTestDeps } from "./testing";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;
const sgd = (a: string) => money(a, "SGD");
const EXPLORER = "https://testnet.xrpl.org/transactions/";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger("test", { level: "debug", sink: (_l, line) => lines.push(line) }) };
}

function envelope(n: number, event: RoveEvent = { type: "shop.updated", merchantId: "ahseng", fields: ["menu"] }): EventEnvelope {
  return { id: `evt_${String(n).padStart(32, "0")}`, at: new Date(1_700_000_000_000 + n * 1000).toISOString(), event };
}

describe("boot", () => {
  test("resumes withdrawals, replays undelivered events oldest first with their ids, logs one summary line", async () => {
    const fake = createFakeDb();
    for (const n of [1, 2, 3]) await fake.db.insertEvent(envelope(n));
    fake.delivered.add(envelope(2).id); // already acknowledged: not replayed
    const delivered: string[] = [];
    const { lines, log } = capture();
    const deps = await createTestDeps({ db: fake.db, log });
    deps.emit.deliver = async (e) => {
      delivered.push(e.id);
      fake.delivered.add(e.id);
      return true;
    };
    let resumed = 0;

    const summary = await boot(deps, { resume: async () => void resumed++ });

    assert.equal(resumed, 1);
    assert.deepEqual(delivered, [envelope(1).id, envelope(3).id]);
    assert.equal(summary.eventsPending, 2);
    assert.equal(summary.eventsDelivered, 2);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.withdrawalsResumed, null, "the fake db can't list withdrawals: counted as unknown, not fatal");
    assert.ok(lines.some((l) => l.endsWith("[test:boot] boot: withdrawals: couldn't count · replayed 2/2 undelivered event(s)")), lines.join("\n"));
  });

  test("a failing withdrawal resume is logged and the replay still runs", async () => {
    const fake = createFakeDb();
    await fake.db.insertEvent(envelope(1));
    const { lines, log } = capture();
    const deps = await createTestDeps({ db: fake.db, log });
    const summary = await boot(deps, {
      resume: async () => {
        throw new Error("xrpl down");
      },
    });
    assert.deepEqual(summary.errors, ["withdrawal resume: xrpl down"]);
    assert.equal(summary.eventsDelivered, 1);
    assert.ok(lines.some((l) => l.includes("ERROR") && l.includes("withdrawal resume failed")));
    assert.ok(lines.some((l) => l.includes("replayed 1/1 undelivered event(s) · 1 step(s) failed (see above)")));
  });

  test(`agent down: stops after ${REPLAY_GIVE_UP_AFTER} failures in a row; the rest wait for the next boot`, async () => {
    const fake = createFakeDb();
    for (let n = 1; n <= 10; n++) await fake.db.insertEvent(envelope(n));
    const { lines, log } = capture();
    const deps = await createTestDeps({ db: fake.db, log });
    let tries = 0;
    deps.emit.deliver = async () => {
      tries++;
      return false;
    };
    const summary = await boot(deps, { resume: async () => {} });
    assert.equal(tries, REPLAY_GIVE_UP_AFTER);
    assert.equal(summary.eventsDelivered, 0);
    assert.equal((await fake.db.listUndeliveredEvents()).length, 10, "nothing lost");
    assert.ok(lines.some((l) => l.includes("agent unreachable: stopped replaying")));
    assert.ok(lines.some((l) => l.includes(`replayed 0/10 undelivered event(s)`)));
  });

  test("real db: counts in-flight withdrawals ('requested' doesn't count); the default resume runs without throwing", { skip }, async (t) => {
    const kit = await createKit(t);
    await liveMerchant(kit.deps);
    await kit.deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("30.00"), ref: "pay_a" });
    const w = await kit.deps.db.insertWithdrawal({
      merchantId: "ahseng",
      amount: sgd("5.00"),
      fee: sgd("0.00"),
      destination: { kind: "xrpl_wallet", address: "rWALLETxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      needsStepUp: false,
    });
    await kit.deps.db.insertWithdrawal({ merchantId: "ahseng", amount: sgd("1.00"), fee: sgd("0.00"), destination: { kind: "xrpl_wallet", address: "rW2" }, needsStepUp: false });
    assert.equal((await kit.deps.db.approveWithdrawal(w.id, "act_1")).ok, true);
    let resumed = 0;
    const summary = await boot(kit.deps, { resume: async () => void resumed++ });
    assert.equal(resumed, 1);
    assert.equal(summary.withdrawalsResumed, 1, `only ${RESUMABLE_WITHDRAWAL_STATUSES.join("/")} count; 'requested' doesn't`);
    assert.equal(summary.eventsPending, 0);
    assert.ok(kit.logs.some((l) => l.includes("boot: resumed 1 withdrawal(s) · no undelivered events")));
    // The default resume (NI-C4's resumeWithdrawals) runs without throwing on the same deps.
    const again = await boot(kit.deps);
    assert.deepEqual(again.errors, []);
  });

  test("describeBoot", () => {
    assert.equal(describeBoot({ withdrawalsResumed: 0, eventsPending: 0, eventsDelivered: 0, errors: [] }), "boot: resumed 0 withdrawal(s) · no undelivered events");
  });
});

describe("money log", () => {
  const settled: RoveEvent = {
    type: "payment.settled",
    paymentId: "pay_1",
    merchantId: "ahseng",
    source: "invoice",
    invoiceId: "inv_1",
    local: sgd("12.50"),
    payer: null,
    txHash: "ABC123",
    delivered: "12.50",
    firstSale: true,
  };

  test("one readable line per money event, before delivery; other events print nothing; installed once", async () => {
    const { lines, log } = capture();
    const deps = await createTestDeps({ db: createFakeDb().db, log });
    const order: string[] = [];
    const inner = deps.emit;
    deps.emit = Object.assign(
      async (e: RoveEvent) => {
        order.push(`emit:${e.type}:${lines.length}`);
        return inner(e);
      },
      { deliver: inner.deliver },
    );
    installMoneyLog(deps);
    installMoneyLog(deps); // idempotent: still one line per event

    await deps.emit(settled);
    await deps.emit({ type: "shop.updated", merchantId: "ahseng", fields: ["menu"] });
    await deps.emit({ type: "withdrawal.updated", withdrawalId: "wd_1", merchantId: "ahseng", status: "onchain_settled", amount: sgd("5.00"), sweepTxHash: "DEF456" });
    await deps.emit({ type: "withdrawal.updated", withdrawalId: "wd_1", merchantId: "ahseng", status: "completed", amount: sgd("5.00"), bankRef: "FAST-881245" });
    await deps.emit({ type: "withdrawal.updated", withdrawalId: "wd_2", merchantId: "ahseng", status: "failed", amount: sgd("9.00"), failureReason: "XRPL said no" });

    const money = lines.filter((l) => l.includes("[test:money]"));
    assert.equal(money.length, 4, money.join("\n"));
    assert.match(money[0]!, new RegExp(`INFO  \\[test:money\\] sale settled\\s+ahseng\\s+\\+S\\$12\\.50  pay_1  ${EXPLORER}ABC123$`));
    assert.match(money[1]!, new RegExp(`withdrawal\\s+ahseng\\s+S\\$5\\.00 → onchain_settled  wd_1  ${EXPLORER}DEF456$`));
    assert.match(money[2]!, /withdrawal\s+ahseng\s+S\$5\.00 → completed  wd_1  \(bank ref FAST-881245\)$/);
    assert.match(money[3]!, /WARN .*withdrawal\s+ahseng\s+S\$9\.00 → failed  wd_2  \(XRPL said no\)$/);
    assert.equal(order[0], "emit:payment.settled:1", "the line is written before the event goes out");
    assert.deepEqual(
      deps.events.map((e) => e.type),
      ["payment.settled", "shop.updated", "withdrawal.updated", "withdrawal.updated", "withdrawal.updated"],
      "every event still reaches the emitter, once",
    );
  });

  test("refund.completed: the explorer link comes from the refund row", { skip }, async (t) => {
    const kit = await createKit(t);
    await liveMerchant(kit.deps);
    await kit.deps.db.insertPayment({
      id: "pay_r",
      merchantId: "ahseng",
      source: "fixed_qr",
      invoiceId: null,
      lines: [],
      local: sgd("6.00"),
      quote: null,
      charge: sgd("6.00"),
      method: "card",
      payer: null,
    });
    const refund = await kit.deps.db.insertRefund({ paymentId: "pay_r", merchantId: "ahseng", actionId: "act_r", amount: sgd("3.00") });
    await kit.deps.db.updateRefund(refund.id, { xrplTxHash: "FFF999" });
    const out = await moneyLine(kit.deps, {
      type: "refund.completed",
      refundId: refund.id,
      paymentId: "pay_r",
      merchantId: "ahseng",
      actionId: "act_r",
      amount: sgd("3.00"),
      payer: null,
    });
    assert.equal(out?.level, "info");
    assert.match(out!.line, new RegExp(`^refund\\s+ahseng\\s+−S\\$3\\.00  ${refund.id}  ${EXPLORER}FFF999$`));
  });

  test("a log failure never blocks the event", async () => {
    const deps = await createTestDeps({ db: createFakeDb().db });
    deps.settlement = { ...deps.settlement, explorerUrl: () => { throw new Error("boom"); } };
    installMoneyLog(deps);
    await deps.emit(settled);
    assert.deepEqual(deps.events.map((e) => e.type), ["payment.settled"]);
  });
});
