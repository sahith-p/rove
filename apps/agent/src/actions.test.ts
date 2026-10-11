import assert from "node:assert/strict";
import { test } from "node:test";
import { money, PENDING_ACTION_TTL_MS, type Merchant } from "@rove/shared";
import { makeHarness, MERCHANT, STRANGER, type Harness } from "./harness.test";
import { WorkerError } from "./ports";

async function shop(h: Harness): Promise<Merchant> {
  return (await h.agent.deps.store.getMerchant("ahseng"))!;
}

async function addBank(h: Harness) {
  await h.agent.deps.store.mock!.addBankAccount({
    merchantId: "ahseng",
    type: "bank_account",
    bankName: "DBS",
    last4: "1234",
    holderName: "AH SENG",
    beneficiaryId: "b1",
    status: "verified",
    isDefault: true,
  });
}

async function proposeAuto(h: Harness) {
  return h.agent.actions.propose(await shop(h), "set_auto_withdraw", { kind: "set_auto_withdraw", mode: "daily" }, "Turn daily auto-withdraw on");
}

async function proposeRefund(h: Harness, amount = "12.50") {
  return h.agent.actions.propose(
    await shop(h),
    "refund",
    { kind: "refund", paymentId: "pay_demo0001", amount: money(amount, "SGD"), reason: "overcharged" },
    `Refund S$${amount} to Maya`,
  );
}

async function proposeWithdrawal(h: Harness, amount: string, wallet?: string) {
  const w = await h.agent.deps.worker.createWithdrawal({
    merchantId: "ahseng",
    amount,
    destination: wallet ? { kind: "xrpl_wallet", address: wallet } : null,
  });
  const action = await h.agent.actions.propose(await shop(h), "withdrawal", { kind: "withdrawal", withdrawalId: w.id }, `Withdraw S$${amount} to ${w.destination.label}`);
  return { w, action };
}

test("propose: confirm card + '👍 this' text, both message ids recorded, 5-minute expiry", async () => {
  const h = makeHarness();
  const a = await proposeAuto(h);
  const sent = h.sentTo(MERCHANT.phone);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["card:confirm", "text"],
  );
  assert.match(sent[1]!.body, /^👍 this and I'll turn daily auto-withdraw on\.$/);
  assert.deepEqual(a.confirmMessageIds, [sent[0]!.messageId, sent[1]!.messageId]);
  assert.equal(new Date(a.expiresAt).getTime() - h.now().getTime(), PENDING_ACTION_TTL_MS);
  assert.match(sent[0]!.card!.url, new RegExp(`/confirm/${a.id}\\?`));
  assert.equal(a.status, "proposed");
});

test("propose (step-up withdrawal): withdrawal card carrying a=<actionId>&c=<confirmToken>, no 👍 ask", async () => {
  const h = makeHarness();
  await addBank(h);
  // Make the balance big enough for a > S$200 step-up withdrawal.
  await h.agent.deps.store.mock!.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: money("300.00", "SGD"), ref: "pay_big" });
  const { w, action } = await proposeWithdrawal(h, "250.00");
  assert.equal(w.needsStepUp, true);
  const sent = h.sentTo(MERCHANT.phone);
  assert.deepEqual(
    sent.map((s) => s.kind),
    ["card:withdrawal", "text"],
  );
  const url = new URL(sent[0]!.card!.url);
  assert.equal(url.searchParams.get("a"), action.id);
  assert.equal(url.searchParams.get("c"), h.agent.deps.confirmToken(action.id, "ahseng"));
  assert.doesNotMatch(sent[1]!.body, /👍/);
  assert.deepEqual(action.confirmMessageIds, [sent[0]!.messageId]);
});

test("confirm: not_found for an unknown id", async () => {
  const h = makeHarness();
  const r = await h.agent.actions.confirm("act_nope", "card");
  assert.equal(r.outcome, "not_found");
});

test("confirm set_auto_withdraw → done; again → already; worker called once", async () => {
  const h = makeHarness();
  const a = await proposeAuto(h);
  const r1 = await h.agent.actions.confirm(a.id, "card");
  assert.equal(r1.outcome, "done");
  assert.equal(r1.action.status, "done");
  const r2 = await h.agent.actions.confirm(a.id, "card");
  assert.equal(r2.outcome, "already");
  assert.equal(h.workerCalls.setAutoWithdraw, 1);
  assert.equal((await h.agent.deps.store.getMerchant("ahseng"))!.autoWithdraw, "daily");
});

test("confirm refund → done (mock worker completes) with one 'Refunded' text", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  h.clear();
  const r = await h.agent.actions.confirm(a.id, "tapback");
  assert.equal(r.outcome, "done");
  assert.equal(h.workerCalls.refund, 1);
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /Refunded S\$12\.50 to Maya/);
});

test("confirm withdrawal (bank, no step-up) → pipeline runs; outcome done or executing; one execute call", async () => {
  const h = makeHarness();
  await addBank(h);
  const { action } = await proposeWithdrawal(h, "10.00");
  const r = await h.agent.actions.confirm(action.id, "tapback");
  assert.ok(r.outcome === "done" || r.outcome === "executing", r.outcome);
  assert.equal(h.workerCalls.executeWithdrawal, 1);
  assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "done");
  const inBank = h.texts(MERCHANT.phone).filter((t) => /in your bank/.test(t));
  assert.equal(inBank.length, 1);
  // With stepDelayMs 0 the pipeline's events land before executeWithdrawal returns: no stale "On it!" after "in your bank".
  assert.equal(h.texts(MERCHANT.phone).filter((t) => /^On it!/.test(t)).length, 0);
  assert.equal((await h.agent.deps.store.getBalance("ahseng")).available.amount, "10.50");
});

test("wallet withdrawal announces 'landed in your wallet' once", async () => {
  const h = makeHarness();
  const { action } = await proposeWithdrawal(h, "5.00", "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY");
  await h.agent.actions.confirm(action.id, "tapback");
  assert.equal(h.texts(MERCHANT.phone).filter((t) => /wallet/.test(t)).length, 1);
});

test("concurrent double confirm → exactly one worker call", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  const [r1, r2] = await Promise.all([h.agent.actions.confirm(a.id, "tapback"), h.agent.actions.confirm(a.id, "card")]);
  assert.equal(h.workerCalls.refund, 1);
  assert.deepEqual([r1.outcome, r2.outcome].sort(), ["already", "done"]);
});

test("confirm after expiry → expired, nothing executed", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  h.advance(PENDING_ACTION_TTL_MS);
  const r = await h.agent.actions.confirm(a.id, "web");
  assert.equal(r.outcome, "expired");
  assert.equal(h.workerCalls.refund, 0);
});

test("confirm on a failed/cancelled action → failed", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  await h.agent.deps.store.claimAction(a.id);
  await h.agent.deps.store.finishAction(a.id, "cancelled");
  const r = await h.agent.actions.confirm(a.id, "card");
  assert.equal(r.outcome, "failed");
});

test("confirmByMessageId: unknown id → false; non-owner → false and nothing runs", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  assert.equal(await h.agent.actions.confirmByMessageId("mock-msg-999", MERCHANT), false);
  assert.equal(await h.agent.actions.confirmByMessageId(a.confirmMessageIds[0]!, STRANGER), false);
  assert.equal(h.workerCalls.refund, 0);
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "proposed");
});

test("confirmByMessageId: 👍 on the card or the text confirms; a second 👍 does nothing", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  assert.equal(await h.agent.actions.confirmByMessageId(a.confirmMessageIds[1]!, MERCHANT), true);
  assert.equal(h.workerCalls.refund, 1);
  const n = h.record.length;
  assert.equal(await h.agent.actions.confirmByMessageId(a.confirmMessageIds[0]!, MERCHANT), true);
  assert.equal(h.workerCalls.refund, 1);
  assert.equal(h.record.length, n, "second 👍 sends nothing");
});

test("late 👍 → one 'expired' text, nothing executed", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  h.advance(PENDING_ACTION_TTL_MS + 1);
  h.clear();
  assert.equal(await h.agent.actions.confirmByMessageId(a.confirmMessageIds[0]!, MERCHANT), true);
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /expired/);
  assert.equal(h.workerCalls.refund, 0);
  // Also after the sweep flipped it to expired.
  await h.agent.actions.sweep();
  h.clear();
  assert.equal(await h.agent.actions.confirmByMessageId(a.confirmMessageIds[1]!, MERCHANT), true);
  assert.match(h.texts(MERCHANT.phone)[0]!, /expired/);
});

test("confirmLatest: 0 open → false; 1 open → confirms; 2 open → lists them, confirms nothing", async () => {
  const h = makeHarness();
  const m = await shop(h);
  assert.equal(await h.agent.actions.confirmLatest(m, MERCHANT), false);

  await proposeAuto(h);
  assert.equal(await h.agent.actions.confirmLatest(m, MERCHANT), true);
  assert.equal(h.workerCalls.setAutoWithdraw, 1);

  await proposeRefund(h, "1.00");
  await proposeRefund(h, "2.00");
  h.clear();
  assert.equal(await h.agent.actions.confirmLatest(m, MERCHANT), true);
  assert.equal(h.workerCalls.refund, 0);
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /2 things waiting/);
  assert.match(t[0]!, /1\) .*2\) /);
});

test("step-up withdrawals execute only via 'web'", async () => {
  const h = makeHarness();
  await addBank(h);
  await h.agent.deps.store.mock!.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: money("300.00", "SGD"), ref: "pay_big" });
  const { action } = await proposeWithdrawal(h, "250.00");
  for (const via of ["tapback", "reply", "card"] as const) {
    const r = await h.agent.actions.confirm(action.id, via);
    assert.equal(r.outcome, "failed", via);
  }
  assert.equal(h.workerCalls.executeWithdrawal, 0);
  assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "proposed", "still confirmable on the web");
  // 👍 on the withdrawal card doesn't run it either
  assert.equal(await h.agent.actions.confirmByMessageId(action.confirmMessageIds[0]!, MERCHANT), true);
  assert.equal(h.workerCalls.executeWithdrawal, 0);
  const r = await h.agent.actions.confirm(action.id, "web");
  assert.notEqual(r.outcome, "failed");
  assert.equal(h.workerCalls.executeWithdrawal, 1);
});

test("sweep(): expires overdue actions and edits their confirm cards to expired", async () => {
  const h = makeHarness();
  const a = await proposeAuto(h);
  await h.agent.actions.sweep();
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "proposed", "not yet");
  h.advance(PENDING_ACTION_TTL_MS + 1);
  h.clear();
  await h.agent.actions.sweep();
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "expired");
  const edits = h.sentTo(MERCHANT.phone, "card-edit:confirm");
  assert.equal(edits.length, 1);
  assert.match(edits[0]!.card!.url, /v=expired/);
});

test("worker failure → action failed + exactly one message", async () => {
  const h = makeHarness();
  h.agent.deps.worker.setAutoWithdraw = async () => {
    throw new WorkerError("Auto-withdraw needs a bank account first.", 422, "no_bank_account");
  };
  const a = await proposeAuto(h);
  h.clear();
  const r = await h.agent.actions.confirm(a.id, "card");
  assert.equal(r.outcome, "failed");
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "failed");
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /needs a bank account first/);
  assert.match(t[0]!, /no money moved/);
});

test("worker 5xx / unreachable → generic reason, not the raw error", async () => {
  const h = makeHarness();
  h.agent.deps.worker.setAutoWithdraw = async () => {
    throw new WorkerError("worker unreachable at http://localhost:4001: ECONNREFUSED", 503);
  };
  const a = await proposeAuto(h);
  h.clear();
  await h.agent.actions.confirm(a.id, "card");
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.doesNotMatch(t[0]!, /localhost|ECONNREFUSED/);
});

test("withdrawal rejected with insufficient_funds → failed, no text from actions (the event says it)", async () => {
  const h = makeHarness();
  await addBank(h);
  const { action } = await proposeWithdrawal(h, "10.00");
  h.agent.deps.worker.executeWithdrawal = async () => {
    throw new WorkerError("Not enough available balance.", 422, "insufficient_funds");
  };
  h.clear();
  const r = await h.agent.actions.confirm(action.id, "tapback");
  assert.equal(r.outcome, "failed");
  assert.equal(h.texts(MERCHANT.phone).length, 0);
});

test("settle(): only moves an executing action, edits its card", async () => {
  const h = makeHarness();
  const a = await proposeRefund(h);
  await h.agent.actions.settle("pay_demo0001", "done");
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "proposed", "proposed actions aren't settled");
  await h.agent.deps.store.claimAction(a.id);
  h.clear();
  await h.agent.actions.settle("pay_demo0001", "failed", { reason: "x" });
  assert.equal((await h.agent.deps.store.getAction(a.id))!.status, "failed");
  assert.equal(h.sentTo(MERCHANT.phone, "card-edit:confirm").length, 1);
  await h.agent.actions.settle("pay_unknown", "done"); // no throw
});

test("summarize(): refund names the contact, withdrawal names the bank, auto-withdraw on/off", async () => {
  const h = makeHarness();
  await addBank(h);
  const refund = await h.agent.deps.store.insertAction({
    merchantId: "ahseng",
    kind: "refund",
    args: { kind: "refund", paymentId: "pay_demo0001", amount: money("12.50", "SGD"), reason: "x" },
    expiresAt: h.now().toISOString(),
  });
  assert.equal(await h.agent.actions.summarize(refund), "Refund S$12.50 to Maya");
  const w = await h.agent.deps.worker.createWithdrawal({ merchantId: "ahseng", amount: "5.00", destination: null });
  const wd = await h.agent.deps.store.insertAction({ merchantId: "ahseng", kind: "withdrawal", args: { kind: "withdrawal", withdrawalId: w.id }, expiresAt: h.now().toISOString() });
  assert.equal(await h.agent.actions.summarize(wd), "Withdraw S$5.00 to DBS ••••1234");
  const off = await h.agent.deps.store.insertAction({ merchantId: "ahseng", kind: "set_auto_withdraw", args: { kind: "set_auto_withdraw", mode: "off" }, expiresAt: h.now().toISOString() });
  assert.equal(await h.agent.actions.summarize(off), "Turn daily auto-withdraw off");
});
