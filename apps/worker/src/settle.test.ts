import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, type Payment, type RoveEvent } from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";
import { isUserFacingError } from "./errors";
import { handleSettle, invoiceIdHex, pollSettlements, settleFrom, settlePayment, startSettlePoller } from "./settle";
import { authorizedPayment, createKit, liveMerchant, MAYA, NO_TEST_DB, testDbAvailable } from "./settle/testkit";
import { classifyXrplError } from "./settle/xrpl-errors";
import { txErrorFor, XrplPathError, XrplTxError } from "@rove/xrpl";
import type { WorkerDeps } from "./deps";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;

const sgd = (a: string) => money(a, "SGD");

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusOf = async (deps: WorkerDeps, id: string) => (await deps.db.getPayment(id))?.status;
const available = async (deps: WorkerDeps, merchantId = "ahseng") => (await deps.db.getBalance(merchantId)).available.amount;
const ofType = <T extends RoveEvent["type"]>(events: RoveEvent[], type: T) =>
  events.filter((e): e is Extract<RoveEvent, { type: T }> => e.type === type);

async function invoiceFor(deps: WorkerDeps) {
  return deps.db.createInvoice({
    merchantId: "ahseng",
    kind: "invoice",
    to: MAYA,
    lines: [
      { menuItemId: null, name: "Chicken rice", qty: 2, unit: sgd("5.50") },
      { menuItemId: null, name: "Barley drink", qty: 1, unit: sgd("1.50") },
    ],
    total: sgd("12.50"),
  });
}

describe("classifyXrplError", () => {
  test("path errors and expired quotes re-quote; sequence races retry", () => {
    assert.equal(classifyXrplError(new Error("tecPATH_PARTIAL (mock)")).kind, "path");
    assert.equal(classifyXrplError(new Error("settle failed: tecPATH_DRY")).kind, "path");
    assert.equal(classifyXrplError({ code: "tecPATH_DRY" }).kind, "path");
    assert.equal(classifyXrplError(new Error("quote expired")).kind, "path");
    assert.equal(classifyXrplError(new Error("tefPAST_SEQ")).kind, "retry");
  });

  test("other ledger rejections are final; unknown outcomes need review", () => {
    assert.deepEqual(classifyXrplError(new Error("tecNO_LINE: merchant trust line")).kind, "definitive");
    assert.equal(classifyXrplError(new Error("temBAD_AMOUNT")).kind, "definitive");
    assert.equal(classifyXrplError(Object.assign(new Error("bad tx"), { name: "ValidationError" })).kind, "definitive");
    assert.equal(classifyXrplError(Object.assign(new Error("nope"), { submitted: false })).kind, "definitive");
    assert.equal(classifyXrplError(new Error("Timeout for request")).kind, "ambiguous");
    assert.equal(classifyXrplError(new Error("terQUEUED")).kind, "ambiguous");
    assert.equal(classifyXrplError("weird").kind, "ambiguous");
  });

  test("the real engine's typed errors", () => {
    assert.equal(classifyXrplError(txErrorFor("tecPATH_DRY", "settle pay_1")).kind, "path");
    assert.equal(classifyXrplError(new XrplPathError("tecPATH_PARTIAL", "path needs 9.80 RLUSD > SendMax 9.79")).kind, "path");
    assert.equal(classifyXrplError(txErrorFor("tecUNFUNDED_PAYMENT", "settle pay_1")).kind, "definitive");
    assert.equal(classifyXrplError(txErrorFor("tecNO_LINE", "settle pay_1")).kind, "definitive");
    assert.equal(classifyXrplError(new XrplTxError("EXPIRED", "not applied after 4 attempts", { retryable: true })).kind, "retry");
    assert.equal(classifyXrplError(new XrplTxError("TIMEOUT", "no validated result after 180s")).kind, "ambiguous");
    const mismatch = classifyXrplError(new XrplTxError("DELIVERED_MISMATCH", "delivered 12.49 XSGD, expected 12.50", { txHash: "ABC" }));
    assert.equal(mismatch.kind, "mismatch");
    assert.equal(mismatch.txHash, "ABC");
  });

  test("settleFrom: the payer's charge currency; token pay-ins (bnb, ausd) are USD", () => {
    assert.equal(settleFrom({ method: "apple_pay", charge: money("9.69", "USD") }), "USD");
    assert.equal(settleFrom({ method: "card", charge: sgd("12.50") }), "SGD");
    assert.equal(settleFrom({ method: "bnb", charge: money("9.69", "USD") }), "USD");
    assert.equal(settleFrom({ method: "ausd", charge: money("9.69", "USD") }), "USD");
    assert.equal(settleFrom({ method: "card" }), "USD");
  });

  test("invoiceIdHex is 64 upper-case hex", () => {
    assert.match(invoiceIdHex("pay_abc"), /^[0-9A-F]{64}$/);
  });
});

describe("settlePayment", { skip }, () => {
  test("happy path: settled, one ledger credit, invoice paid, payer added, payment.settled (firstSale true, then false)", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const inv = await invoiceFor(deps);
    const p1 = await authorizedPayment(deps, { invoiceId: inv.id });

    await settlePayment(deps, p1.id);

    const s1 = (await deps.db.getPayment(p1.id))!;
    assert.equal(s1.status, "settled");
    assert.equal(s1.settleTxHash, "SETTLE1");
    assert.equal(money(s1.deliveredAmount!, "SGD").amount, "12.50");
    assert.equal(engine.calls.settle.length, 1);
    assert.equal(engine.calls.settle[0]!.merchantAddress, "rTESTAHSENG");
    assert.deepEqual(engine.calls.settle[0]!.local, sgd("12.50"));
    assert.equal(engine.calls.quote, 0, "the stored quote is still valid");
    assert.equal((await deps.db.getInvoice(inv.id))?.status, "paid");
    assert.equal(await available(deps), "12.50");
    assert.equal(await deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("12.50"), ref: p1.id }), false, "credit exists");
    assert.ok((await deps.db.findContacts("ahseng")).some((c) => c.phone === MAYA.phone), "payer auto-added");
    assert.deepEqual(deps.events, [
      {
        type: "payment.settled",
        paymentId: p1.id,
        merchantId: "ahseng",
        source: "invoice",
        invoiceId: inv.id,
        local: sgd("12.50"),
        payer: MAYA,
        txHash: "SETTLE1",
        delivered: "12.50",
        firstSale: true,
      },
    ]);

    const p2 = await authorizedPayment(deps, { local: "4.50" });
    await settlePayment(deps, p2.id);
    const settled = ofType(deps.events, "payment.settled");
    assert.equal(settled.length, 2);
    assert.equal(settled[1]!.firstSale, false);
    assert.equal(settled[1]!.source, "fixed_qr");
    assert.equal(await available(deps), "17.00");
  });

  test("duplicate attempts settle once and credit once", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);

    await Promise.all([settlePayment(deps, p.id), settlePayment(deps, p.id), handleSettle(deps, { paymentId: p.id }), pollSettlements(deps)]);
    await waitFor(async () => (await statusOf(deps, p.id)) === "settled");
    await settlePayment(deps, p.id); // a late nudge
    await handleSettle(deps, { paymentId: p.id });
    await pollSettlements(deps);

    assert.equal(engine.calls.settle.length, 1);
    assert.equal(await available(deps), "12.50");
    assert.equal(ofType(deps.events, "payment.settled").length, 1);
  });

  test("from: USD payers swap RLUSD with the stored SendMax, SGD payers send XSGD, bnb is USD", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const usd = await authorizedPayment(deps);
    const sgdPayer = await authorizedPayment(deps, { charge: sgd("12.50") });
    const bnb = await authorizedPayment(deps, { method: "bnb" });

    for (const p of [usd, sgdPayer, bnb]) await settlePayment(deps, p.id);

    const byId = new Map(engine.calls.settle.map((c) => [c.paymentId, c]));
    assert.equal(byId.get(usd.id)?.from, "USD");
    assert.equal(byId.get(usd.id)?.sendMaxUsd, usd.quote!.sendMaxUsd);
    assert.equal(byId.get(sgdPayer.id)?.from, "SGD");
    assert.equal(byId.get(bnb.id)?.from, "USD");
    assert.equal(ofType(deps.events, "payment.settled").length, 3);
    assert.equal(await available(deps), "37.50");
  });

  test("an expired stored quote is replaced before the first attempt", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const quote = await createMockSettlement().quote({ local: sgd("12.50") });
    const p = await authorizedPayment(deps, { quote: { ...quote, sendMaxUsd: "9.99", expiresAt: new Date(Date.now() - 1000).toISOString() } });

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.quote, 1);
    assert.equal(engine.calls.settle.length, 1);
    assert.equal(engine.calls.settle[0]!.sendMaxUsd, quote.sendMaxUsd, "fresh SendMax, not the stale 9.99");
    assert.equal(await statusOf(deps, p.id), "settled");
  });

  test("path error → fresh quote → retry succeeds", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const quote = await createMockSettlement().quote({ local: sgd("12.50") });
    const p = await authorizedPayment(deps, { quote: { ...quote, sendMaxUsd: "9.99" } });
    engine.settleErrors.push(new Error("tecPATH_DRY: no path"));

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.settle.length, 2);
    assert.equal(engine.calls.settle[0]!.sendMaxUsd, "9.99");
    assert.equal(engine.calls.settle[1]!.sendMaxUsd, quote.sendMaxUsd);
    assert.equal(engine.calls.quote, 1);
    assert.equal(await statusOf(deps, p.id), "settled");
    assert.equal(await available(deps), "12.50");
    assert.equal(stripe.calls.length, 0);
    assert.deepEqual(deps.events.map((e) => e.type), ["payment.settled"]);
  });

  test("final failure after 2 retries: failed, full Stripe refund, payment.failed, no credit", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const inv = await invoiceFor(deps);
    const p = await authorizedPayment(deps, { invoiceId: inv.id });
    engine.settleErrors.push(new Error("tecPATH_PARTIAL"), new Error("tecPATH_PARTIAL"), new Error("tecPATH_PARTIAL"));

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.settle.length, 3, "first attempt + 2 retries");
    assert.equal(engine.calls.quote, 2, "a fresh quote per retry");
    assert.equal(await statusOf(deps, p.id), "failed");
    assert.deepEqual(stripe.calls, [{ params: { payment_intent: p.stripePaymentIntentId }, options: { idempotencyKey: `settle-fail:${p.id}` } }]);
    const failed = ofType(deps.events, "payment.failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.paymentId, p.id);
    assert.equal(failed[0]!.merchantId, "ahseng");
    assert.match(failed[0]!.reason, /tecPATH_PARTIAL/);
    assert.equal(ofType(deps.events, "payment.settled").length, 0);
    assert.equal(await available(deps), "0.00");
    assert.equal((await deps.db.getInvoice(inv.id))?.status, "open", "the customer can still pay the invoice");

    await settlePayment(deps, p.id); // a late retry does nothing
    assert.equal(engine.calls.settle.length, 3);
    assert.equal(stripe.calls.length, 1);
  });

  test("any other XRPL rejection fails at once (no retries)", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    engine.settleErrors.push(new Error("tecNO_LINE"));

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.settle.length, 1);
    assert.equal(await statusOf(deps, p.id), "failed");
    assert.equal(stripe.calls.length, 1);
    assert.match(ofType(deps.events, "payment.failed")[0]!.reason, /tecNO_LINE/);
  });

  test("delivered ≠ local: not credited, failed loudly + refunded", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    engine.delivered = () => "12.49";

    await settlePayment(deps, p.id);

    assert.equal(await statusOf(deps, p.id), "failed");
    assert.equal(await available(deps), "0.00");
    assert.equal(stripe.calls.length, 1);
    assert.match(ofType(deps.events, "payment.failed")[0]!.reason, /delivered 12\.49/);
    assert.ok(logs.some((l) => l.includes("ERROR") && l.includes("payment failed")));
  });

  test("delivered with extra zeros (12.500000) counts as exact", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    engine.delivered = () => "12.500000";

    await settlePayment(deps, p.id);

    assert.equal(await statusOf(deps, p.id), "settled");
    assert.equal(ofType(deps.events, "payment.settled")[0]!.delivered, "12.50");
  });

  test("unknown XRPL outcome: stays settling, no refund, no event, logged for review", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    engine.settleErrors.push(new Error("socket hang up"));

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.settle.length, 1, "never retried: it may have gone through");
    assert.equal(await statusOf(deps, p.id), "settling");
    assert.equal(stripe.calls.length, 0);
    assert.equal(deps.events.length, 0);
    assert.ok(logs.some((l) => l.includes("for review") && l.includes(invoiceIdHex(p.id))));
  });

  test("real engine: XrplPathError re-quotes; DELIVERED_MISMATCH fails without credit and keeps the tx hash", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const a = await authorizedPayment(deps);
    engine.settleErrors.push(txErrorFor("tecPATH_DRY", `settle ${a.id}`));
    await settlePayment(deps, a.id);
    assert.equal(await statusOf(deps, a.id), "settled");
    assert.equal(engine.calls.quote, 1);

    const b = await authorizedPayment(deps);
    engine.settleErrors.push(new XrplTxError("DELIVERED_MISMATCH", "delivered 12.49 XSGD, expected 12.50", { txHash: "MISMATCHTX" }));
    await settlePayment(deps, b.id);
    const failed = (await deps.db.getPayment(b.id))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.settleTxHash, "MISMATCHTX");
    assert.equal(await available(deps), "12.50", "only the first payment is credited");
    assert.equal(stripe.calls.length, 1);
    assert.match(ofType(deps.events, "payment.failed")[0]!.reason, /delivered 12\.49/);
  });

  test("ausd settles from USD; its final failure skips Stripe (token refund pending review)", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const ok = await authorizedPayment(deps, { method: "ausd" });
    await settlePayment(deps, ok.id);
    assert.equal(engine.calls.settle[0]!.from, "USD");
    assert.equal(await statusOf(deps, ok.id), "settled");

    const bad = await authorizedPayment(deps, { method: "ausd" });
    engine.settleErrors.push(new Error("tecUNFUNDED_PAYMENT"));
    await settlePayment(deps, bad.id);
    assert.equal(await statusOf(deps, bad.id), "failed");
    assert.equal(stripe.calls.length, 0);
    assert.ok(logs.some((l) => l.includes("AUSD") && l.includes("refund pending review")));
  });

  test("bnb final failure: no Stripe call, refund pending review", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps, { method: "bnb" });
    engine.settleErrors.push(new Error("tecPATH_DRY"), new Error("tecPATH_DRY"), new Error("tecPATH_DRY"));

    await settlePayment(deps, p.id);

    assert.equal(await statusOf(deps, p.id), "failed");
    assert.equal(stripe.calls.length, 0);
    assert.ok(logs.some((l) => l.includes("refund pending review")));
    assert.equal(ofType(deps.events, "payment.failed").length, 1);
  });

  test("merchant without an XRPL account: clean failure + refund", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await deps.db.upsertDraftMerchant({ id: "ahseng", name: "Ah Seng", phone: "+15555557777", channel: "imessage", currency: "SGD" });
    const p = await authorizedPayment(deps);

    await settlePayment(deps, p.id);

    assert.equal(engine.calls.settle.length, 0);
    assert.equal(await statusOf(deps, p.id), "failed");
    assert.equal(stripe.calls.length, 1);
  });

  test("MOCK_SETTLE_FAIL=1 (shared mock engine): 2 retries → failed → Stripe refund → payment.failed", async (t) => {
    const prev = process.env.MOCK_SETTLE_FAIL;
    process.env.MOCK_SETTLE_FAIL = "1";
    t.after(() => {
      if (prev === undefined) delete process.env.MOCK_SETTLE_FAIL;
      else process.env.MOCK_SETTLE_FAIL = prev;
    });
    const { deps, stripe } = await createKit(t, { settlement: createMockSettlement() });
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);

    await settlePayment(deps, p.id); // ~4.5s: the mock "closes a ledger" in 1.5s per attempt

    assert.equal(await statusOf(deps, p.id), "failed");
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0]!.options?.idempotencyKey, `settle-fail:${p.id}`);
    assert.deepEqual(deps.events.map((e) => e.type), ["payment.failed"]);
  });
});

describe("handleSettle", { skip }, () => {
  test("unknown payment → 404", async (t) => {
    const { deps } = await createKit(t);
    await assert.rejects(handleSettle(deps, { paymentId: "pay_nope" }), (err) => isUserFacingError(err) && err.status === 404);
  });

  test("returns before settlement finishes, which then completes in the background", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    engine.settleDelayMs = 100;
    const p = await authorizedPayment(deps);

    await handleSettle(deps, { paymentId: p.id });
    assert.notEqual(await statusOf(deps, p.id), "settled");
    await waitFor(async () => (await statusOf(deps, p.id)) === "settled");
    assert.equal(ofType(deps.events, "payment.settled").length, 1);
  });

  test("a payment that isn't authorized yet is ignored (the poller gets it later)", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    await deps.db.transitionPayment(p.id, ["authorized"], "failed");

    await handleSettle(deps, { paymentId: p.id });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.calls.settle.length, 0);
  });
});

describe("settle poller", { skip }, () => {
  test("settles authorized payments, one at a time per merchant, merchants in parallel", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps, "ahseng");
    await liveMerchant(deps, "kopi");
    engine.settleDelayMs = 30;
    const ps: Payment[] = [];
    for (let i = 0; i < 3; i++) ps.push(await authorizedPayment(deps, { local: `${i + 1}.00` }));
    ps.push(await authorizedPayment(deps, { merchantId: "kopi" }));

    await pollSettlements(deps);

    for (const p of ps) assert.equal(await statusOf(deps, p.id), "settled");
    assert.equal(engine.maxConcurrent.byAddress.get("rTESTAHSENG"), 1);
    assert.equal(engine.maxConcurrent.all, 2);
    assert.equal(await available(deps, "ahseng"), "6.00");
    assert.equal(await available(deps, "kopi"), "12.50");
  });

  test("startSettlePoller picks up an authorized payment on its own; the stopper stops it", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    const stop = startSettlePoller(deps);
    t.after(stop);
    const p = await authorizedPayment(deps);
    await waitFor(async () => (await statusOf(deps, p.id)) === "settled");
    stop();
    const later = await authorizedPayment(deps);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await statusOf(deps, later.id), "authorized");
  });

  test("a payment stuck in settling is reported once and never re-settled", async (t) => {
    const later = new Date(Date.now() + 5 * 60_000);
    const { deps, engine, logs } = await createKit(t, { now: () => later });
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    await deps.db.transitionPayment(p.id, ["authorized"], "settling"); // a crash mid-settle

    await pollSettlements(deps);
    await pollSettlements(deps);

    assert.equal(engine.calls.settle.length, 0);
    assert.equal(await statusOf(deps, p.id), "settling");
    const reports = logs.filter((l) => l.includes("stuck in settling") && l.includes(p.id));
    assert.equal(reports.length, 1);
    assert.ok(reports[0]!.includes(invoiceIdHex(p.id)));
  });

  test("a recent settling payment isn't reported yet", async (t) => {
    const { deps, logs } = await createKit(t);
    await liveMerchant(deps);
    const p = await authorizedPayment(deps);
    await deps.db.transitionPayment(p.id, ["authorized"], "settling");
    await pollSettlements(deps);
    assert.equal(logs.filter((l) => l.includes("stuck in settling")).length, 0);
  });
});
