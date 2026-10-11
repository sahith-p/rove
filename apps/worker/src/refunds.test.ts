import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, type Payment, type RoveEvent } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import { isUserFacingError } from "./errors";
import { handleRefund, stripeRefundMinor } from "./refunds";
import { createServer } from "./server";
import { settlePayment } from "./settle";
import { authorizedPayment, createKit, liveMerchant, MAYA, NO_TEST_DB, testDbAvailable, type PaymentOpts } from "./settle/testkit";
import { TEST_INTERNAL_SECRET } from "./testing";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;

const sgd = (a: string) => money(a, "SGD");
const usd = (a: string) => money(a, "USD");
const available = async (deps: WorkerDeps) => (await deps.db.getBalance("ahseng")).available.amount;
const ofType = <T extends RoveEvent["type"]>(events: RoveEvent[], type: T) =>
  events.filter((e): e is Extract<RoveEvent, { type: T }> => e.type === type);

/** A settled payment: S$12.50 charged US$9.69 (mock rate 1.29) unless overridden. */
async function settled(deps: WorkerDeps, o: PaymentOpts = {}): Promise<Payment> {
  const p = await authorizedPayment(deps, o);
  await settlePayment(deps, p.id);
  const s = (await deps.db.getPayment(p.id))!;
  assert.equal(s.status, "settled");
  return s;
}

const rejectsWith = (code: string, message?: RegExp) => (err: unknown) => {
  assert.ok(isUserFacingError(err), `expected UserFacingError, got ${String(err)}`);
  assert.equal(err.code, code);
  if (message) assert.match(err.message, message);
  return true;
};

describe("stripeRefundMinor", () => {
  const card = { method: "card" as const, local: sgd("12.50"), charge: usd("9.69") };
  test("full refund → the whole charge", () => assert.equal(stripeRefundMinor(card, sgd("12.50")), 969n));
  test("partial → charge × amount / local, rounded down", () => {
    assert.equal(stripeRefundMinor(card, sgd("5.00")), 387n); // 387.6
    assert.equal(stripeRefundMinor(card, sgd("7.50")), 581n); // 581.4
    assert.equal(stripeRefundMinor(card, sgd("0.01")), 0n);
  });
  test("SGD charge: same amount back", () => assert.equal(stripeRefundMinor({ ...card, charge: sgd("12.50") }, sgd("5.00")), 500n));
  test("token pay-ins have no card", () => {
    assert.equal(stripeRefundMinor({ ...card, method: "bnb" }, sgd("5.00")), null);
    assert.equal(stripeRefundMinor({ ...card, method: "ausd" }, sgd("5.00")), null);
  });
});

describe("handleRefund", { skip }, () => {
  test("full refund of a USD charge: one XRPL tx, the whole charge back on the card, one refund_debit", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    assert.deepEqual(p.charge, usd("9.69"));

    const r = await handleRefund(deps, { actionId: "act_full", paymentId: p.id, amount: "12.50" });

    assert.equal(r.status, "completed");
    assert.deepEqual(engine.calls.refund, [{ paymentId: p.id, merchantAddress: "rTESTAHSENG", local: sgd("12.50") }]);
    assert.deepEqual(stripe.calls, [{ params: { payment_intent: p.stripePaymentIntentId, amount: 969 }, options: { idempotencyKey: "refund:act_full" } }]);
    const row = (await deps.db.getRefundByAction("act_full"))!;
    assert.equal(row.id, r.refundId);
    assert.equal(row.status, "completed");
    assert.ok(row.xrplTxHash?.startsWith("REFUND"));
    assert.ok(row.stripeRefundId?.startsWith("re_test"));
    const after = (await deps.db.getPayment(p.id))!;
    assert.equal(after.status, "refunded");
    assert.deepEqual(after.refunded, sgd("12.50"));
    assert.equal(await available(deps), "0.00");
    assert.equal(await deps.db.appendLedger({ merchantId: "ahseng", kind: "refund_debit", amount: sgd("12.50"), ref: r.refundId }), false);
    assert.deepEqual(ofType(deps.events, "refund.completed"), [
      { type: "refund.completed", refundId: r.refundId, paymentId: p.id, merchantId: "ahseng", actionId: "act_full", amount: sgd("12.50"), payer: MAYA },
    ]);
  });

  test("partial refunds of a USD charge: proportional, rounded down; status partially_refunded → refunded", async (t) => {
    const { deps, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);

    assert.equal((await handleRefund(deps, { actionId: "act_p1", paymentId: p.id, amount: "5" })).status, "completed");
    assert.equal(stripe.calls[0]!.params.amount, 387);
    let after = (await deps.db.getPayment(p.id))!;
    assert.equal(after.status, "partially_refunded");
    assert.deepEqual(after.refunded, sgd("5.00"));
    assert.equal(await available(deps), "7.50");

    await assert.rejects(handleRefund(deps, { actionId: "act_p2", paymentId: p.id, amount: "7.51" }), rejectsWith("amount_too_large", /S\$7\.50/));

    assert.equal((await handleRefund(deps, { actionId: "act_p3", paymentId: p.id, amount: "7.50" })).status, "completed");
    assert.equal(stripe.calls[1]!.params.amount, 581);
    assert.equal(stripe.calls[1]!.options?.idempotencyKey, "refund:act_p3");
    after = (await deps.db.getPayment(p.id))!;
    assert.equal(after.status, "refunded");
    assert.equal(await available(deps), "0.00");
    assert.equal(ofType(deps.events, "refund.completed").length, 2);
  });

  test("partial refund of an SGD charge sends back the same amount", async (t) => {
    const { deps, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps, { charge: sgd("12.50") });
    await handleRefund(deps, { actionId: "act_sgd", paymentId: p.id, amount: "5.00" });
    assert.equal(stripe.calls[0]!.params.amount, 500);
  });

  test("idempotent on actionId: a replay returns the same refund and moves nothing", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);

    const first = await handleRefund(deps, { actionId: "act_1", paymentId: p.id, amount: "5.00" });
    const again = await handleRefund(deps, { actionId: "act_1", paymentId: p.id, amount: "5.00" });
    const odd = await handleRefund(deps, { actionId: "act_1", paymentId: p.id, amount: "1.00" });

    assert.deepEqual(again, first);
    assert.deepEqual(odd, first);
    assert.equal(engine.calls.refund.length, 1);
    assert.equal(stripe.calls.length, 1);
    assert.equal(ofType(deps.events, "refund.completed").length, 1);
    assert.equal(await available(deps), "7.50");
  });

  test("concurrent calls: the same action runs once; two full refunds of one payment can't both go through", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);

    const results = await Promise.allSettled([
      handleRefund(deps, { actionId: "act_same", paymentId: p.id, amount: "12.50" }),
      handleRefund(deps, { actionId: "act_same", paymentId: p.id, amount: "12.50" }),
      handleRefund(deps, { actionId: "act_other", paymentId: p.id, amount: "12.50" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ refundId: string }>).value.refundId);
    assert.ok(won.length >= 1);
    assert.equal(new Set(won).size, 1, "every fulfilled call reports the same single refund");
    for (const r of results) if (r.status === "rejected") rejectsWith("already_refunded")(r.reason);
    assert.equal(engine.calls.refund.length, 1);
    assert.equal(await available(deps), "0.00");
    assert.equal(ofType(deps.events, "refund.completed").length, 1);
  });

  test("insufficient available balance: readable refusal, nothing created or moved", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "withdrawal_hold", amount: sgd("10.00"), ref: "wd_test" });

    await assert.rejects(
      handleRefund(deps, { actionId: "act_broke", paymentId: p.id, amount: "5.00" }),
      rejectsWith("insufficient_funds", /Only S\$2\.50 is available.*S\$5\.00/),
    );
    assert.equal(await deps.db.getRefundByAction("act_broke"), null);
    assert.equal(engine.calls.refund.length, 0);
    assert.equal(stripe.calls.length, 0);
    assert.equal(deps.events.length - ofType(deps.events, "payment.settled").length, 0);
  });

  test("Stripe fails after XRPL: pending; the retry resumes at Stripe without a second XRPL transfer or ledger entry", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    stripe.failNext = 1;

    const first = await handleRefund(deps, { actionId: "act_resume", paymentId: p.id, amount: "5.00" });
    assert.equal(first.status, "pending");
    let row = (await deps.db.getRefundByAction("act_resume"))!;
    assert.ok(row.xrplTxHash);
    assert.equal(row.stripeRefundId, undefined);
    assert.equal(engine.calls.refund.length, 1);
    assert.equal(await available(deps), "7.50", "the ledger already matches XRPL");
    assert.equal((await deps.db.getPayment(p.id))!.status, "settled");
    assert.equal(ofType(deps.events, "refund.completed").length + ofType(deps.events, "refund.failed").length, 0);

    const second = await handleRefund(deps, { actionId: "act_resume", paymentId: p.id, amount: "5.00" });

    assert.deepEqual(second, { refundId: first.refundId, status: "completed" });
    assert.equal(engine.calls.refund.length, 1, "no second XRPL refund");
    assert.equal(stripe.calls.length, 2);
    assert.deepEqual(stripe.calls[0], stripe.calls[1], "same params + idempotency key");
    assert.equal(stripe.created.size, 1);
    assert.equal(await deps.db.appendLedger({ merchantId: "ahseng", kind: "refund_debit", amount: sgd("5.00"), ref: first.refundId }), false);
    assert.equal(await available(deps), "7.50", "refund_debit once");
    row = (await deps.db.getRefundByAction("act_resume"))!;
    assert.equal(row.status, "completed");
    assert.equal((await deps.db.getPayment(p.id))!.status, "partially_refunded");
    assert.equal(ofType(deps.events, "refund.completed").length, 1);
  });

  test("XRPL rejects the transfer: refund failed + refund.failed, nothing moved; replay stays failed", async (t) => {
    const { deps, engine, stripe } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    engine.refundErrors.push(new Error("tecUNFUNDED_PAYMENT (test)"));

    const r = await handleRefund(deps, { actionId: "act_rej", paymentId: p.id, amount: "5.00" });

    assert.equal(r.status, "failed");
    assert.equal(stripe.calls.length, 0);
    assert.equal(await available(deps), "12.50");
    const failed = ofType(deps.events, "refund.failed");
    assert.equal(failed.length, 1);
    assert.deepEqual({ ...failed[0], reason: undefined }, {
      type: "refund.failed",
      refundId: r.refundId,
      paymentId: p.id,
      merchantId: "ahseng",
      actionId: "act_rej",
      reason: undefined,
    });
    assert.match(failed[0]!.reason, /nothing was refunded/);

    assert.deepEqual(await handleRefund(deps, { actionId: "act_rej", paymentId: p.id, amount: "5.00" }), r);
    assert.equal(engine.calls.refund.length, 1);
    assert.equal(ofType(deps.events, "refund.failed").length, 1);
  });

  test("unknown XRPL outcome: pending for review, never re-sent", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    engine.refundErrors.push(new Error("socket hang up"));

    assert.equal((await handleRefund(deps, { actionId: "act_unk", paymentId: p.id, amount: "5.00" })).status, "pending");
    assert.equal((await handleRefund(deps, { actionId: "act_unk", paymentId: p.id, amount: "5.00" })).status, "pending");

    assert.equal(engine.calls.refund.length, 1);
    assert.equal(stripe.calls.length, 0);
    assert.equal(await available(deps), "12.50");
    assert.ok(logs.some((l) => l.includes("not re-sending")));
  });

  test("bnb / ausd: XRPL + ledger done, completed, the token return is logged as a manual step", async (t) => {
    const { deps, engine, stripe, logs } = await createKit(t);
    await liveMerchant(deps);
    const bnb = await settled(deps, { method: "bnb" });
    const ausd = await settled(deps, { method: "ausd", local: "5.00" });

    assert.equal((await handleRefund(deps, { actionId: "act_bnb", paymentId: bnb.id, amount: "12.50" })).status, "completed");
    assert.equal((await handleRefund(deps, { actionId: "act_ausd", paymentId: ausd.id, amount: "5.00" })).status, "completed");

    assert.equal(engine.calls.refund.length, 2);
    assert.equal(stripe.calls.length, 0);
    assert.equal(await available(deps), "0.00");
    assert.ok(logs.some((l) => l.includes("MANUAL STEP") && l.includes("US$9.69") && l.includes("USDT")));
    assert.ok(logs.some((l) => l.includes("MANUAL STEP") && l.includes("AUSD")));
    assert.equal(ofType(deps.events, "refund.completed").length, 2);
  });

  test("refusals the agent can say", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    const pending = await authorizedPayment(deps);

    await assert.rejects(handleRefund(deps, { actionId: "a1", paymentId: "pay_nope", amount: "1.00" }), rejectsWith("payment_not_found"));
    await assert.rejects(handleRefund(deps, { actionId: "a2", paymentId: p.id, amount: "0" }), rejectsWith("invalid_amount"));
    await assert.rejects(handleRefund(deps, { actionId: "a3", paymentId: p.id, amount: "1.234" }), rejectsWith("invalid_amount"));
    await assert.rejects(handleRefund(deps, { actionId: "a4", paymentId: p.id, amount: "12.51" }), rejectsWith("amount_too_large", /S\$12\.50/));
    await assert.rejects(handleRefund(deps, { actionId: "a5", paymentId: p.id, amount: "0.01" }), rejectsWith("amount_too_small"));
    await assert.rejects(handleRefund(deps, { actionId: "a6", paymentId: pending.id, amount: "1.00" }), rejectsWith("not_settled"));
    await handleRefund(deps, { actionId: "a7", paymentId: p.id, amount: "12.50" });
    await assert.rejects(handleRefund(deps, { actionId: "a8", paymentId: p.id, amount: "1.00" }), rejectsWith("already_refunded"));
    assert.equal(engine.calls.refund.length, 1);
  });

  test("Stripe not configured: card refunds refuse before any money moves", async (t) => {
    const { deps, engine } = await createKit(t, { stripe: null });
    await liveMerchant(deps);
    const p = await settled(deps);
    await assert.rejects(handleRefund(deps, { actionId: "a_ns", paymentId: p.id, amount: "1.00" }), rejectsWith("refunds_unavailable"));
    assert.equal(engine.calls.refund.length, 0);
  });

  test("over HTTP: 200 { refundId, status } and 422 insufficient_funds", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    const p = await settled(deps);
    const server = createServer(deps);
    const call = (body: unknown) =>
      server.request("/internal/refunds", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await call({ actionId: "act_http", paymentId: p.id, amount: "12.50" });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys((await ok.json()) as object).sort(), ["refundId", "status"]);

    const p2 = await settled(deps, { local: "3.00" });
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "withdrawal_hold", amount: sgd("3.00"), ref: "wd_http" });
    const broke = await call({ actionId: "act_http2", paymentId: p2.id, amount: "3.00" });
    assert.equal(broke.status, 422);
    assert.equal(((await broke.json()) as { error: string }).error, "insufficient_funds");
  });
});
