import assert from "node:assert/strict";
import { test } from "node:test";
import { money, type Withdrawal } from "@rove/shared";
import { CUSTOMER, makeHarness, MERCHANT, type Harness } from "./harness.test";

async function openInvoiceTo(h: Harness, phone: string) {
  return (await h.agent.deps.store.openInvoicesForPhone(phone)).find((i) => i.code === "M4YA22")!;
}

async function addBank(h: Harness) {
  return h.agent.deps.store.mock!.addBankAccount({
    merchantId: "ahseng",
    type: "bank_account",
    bankName: "DBS",
    last4: "1234",
    holderName: "AH SENG FOOD PTE LTD",
    beneficiaryId: "b1",
    status: "verified",
    isDefault: true,
  });
}

test("payment.settled: sale card to the merchant, paid invoice edit + receipt to the payer, confetti only on firstSale", async () => {
  const h = makeHarness();
  const inv = await openInvoiceTo(h, CUSTOMER.phone);
  // The pay card the customer holds (so the "Paid ✓" update is an edit, not a new bubble).
  await h.agent.deps.outbox.cards.send(CUSTOMER, h.agent.deps.builders.invoice({ invoice: inv, merchant: (await h.agent.deps.store.getMerchant("ahseng"))! }));
  const p = await h.agent.deps.store.mock!.payInvoice("M4YA22", CUSTOMER);
  h.clear();
  await h.emit({
    type: "payment.settled",
    paymentId: p.id,
    merchantId: "ahseng",
    source: "invoice",
    invoiceId: inv.id,
    local: p.local,
    payer: CUSTOMER,
    txHash: "0".repeat(64),
    delivered: "6.5",
    firstSale: false,
  });
  assert.equal(h.sentTo(MERCHANT.phone, "card:sale").length, 1);
  assert.equal(h.sentTo(MERCHANT.phone, "effect").length, 0);
  const edits = h.sentTo(CUSTOMER.phone, "card-edit:invoice");
  assert.equal(edits.length, 1, "the customer's pay card is edited in place");
  assert.match(edits[0]!.card!.url, /v=paid/);
  assert.equal(h.sentTo(CUSTOMER.phone, "card:receipt").length, 1);
  assert.equal(h.sentTo(CUSTOMER.phone, "card:invoice").length, 0, "no new invoice bubble");

  h.clear();
  const p2 = await h.agent.deps.store.mock!.payInvoice("K7Q2MX", CUSTOMER);
  await h.emit({ type: "payment.settled", paymentId: p2.id, merchantId: "ahseng", source: "one_time_qr", invoiceId: null, local: p2.local, payer: null, txHash: "0".repeat(64), delivered: "6.5", firstSale: true });
  const fx = h.sentTo(MERCHANT.phone, "effect");
  assert.equal(fx.length, 1);
  assert.match(fx[0]!.body, /first sale/i);
  assert.match(fx[0]!.body, /a customer/);
  assert.equal(h.record.filter((r) => r.to === CUSTOMER.phone).length, 0, "no payer → nothing to the customer");
});

test("payment.failed: one line to the merchant and one to the payer", async () => {
  const h = makeHarness();
  await h.emit({ type: "payment.failed", paymentId: "pay_demo0001", merchantId: "ahseng", reason: "xrpl dry" });
  assert.equal(h.texts(MERCHANT.phone).length, 1);
  assert.equal(h.texts(CUSTOMER.phone).length, 1);
  assert.match(h.texts(CUSTOMER.phone)[0]!, /weren't charged/);
});

test("refund.completed: settles the action, edits the sale card, tells the payer once", async () => {
  const h = makeHarness();
  const merchant = (await h.agent.deps.store.getMerchant("ahseng"))!;
  const pay = (await h.agent.deps.store.getPayment("pay_demo0001"))!;
  await h.agent.deps.outbox.cards.send(MERCHANT, h.agent.deps.builders.sale({ payment: pay, merchant, sessionToken: "t" }));
  const action = await h.agent.deps.store.insertAction({
    merchantId: "ahseng",
    kind: "refund",
    args: { kind: "refund", paymentId: "pay_demo0001", amount: money("12.50", "SGD"), reason: "x" },
    expiresAt: new Date(h.now().getTime() + 60_000).toISOString(),
  });
  await h.agent.deps.store.claimAction(action.id);
  h.clear();
  await h.emit({ type: "refund.completed", refundId: "ref_1", paymentId: "pay_demo0001", merchantId: "ahseng", actionId: action.id, amount: money("12.50", "SGD"), payer: CUSTOMER });
  assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "done");
  assert.equal(h.sentTo(MERCHANT.phone, "card-edit:sale").length, 1);
  const toPayer = h.texts(CUSTOMER.phone);
  assert.equal(toPayer.length, 1);
  assert.match(toPayer[0]!, /refunded you S\$12\.50/);
});

test("refund.failed: action failed + one merchant line", async () => {
  const h = makeHarness();
  const action = await h.agent.deps.store.insertAction({
    merchantId: "ahseng",
    kind: "refund",
    args: { kind: "refund", paymentId: "pay_demo0002", amount: money("8.00", "SGD"), reason: "x" },
    expiresAt: new Date(h.now().getTime() + 60_000).toISOString(),
  });
  await h.agent.deps.store.claimAction(action.id);
  await h.emit({ type: "refund.failed", refundId: "ref_2", paymentId: "pay_demo0002", merchantId: "ahseng", actionId: action.id, reason: "card expired" });
  assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "failed");
  assert.equal(h.texts(MERCHANT.phone).length, 1);
  assert.match(h.texts(MERCHANT.phone)[0]!, /card expired/);
});

for (const status of ["approved", "onchain_pending", "onchain_settled", "payout_pending"] as const) {
  test(`withdrawal.updated ${status} (bank): card edit only, no text`, async () => {
    const h = makeHarness();
    await addBank(h);
    const w = await h.agent.deps.worker.createWithdrawal({ merchantId: "ahseng", amount: "5.00", destination: null });
    await h.agent.deps.outbox.cards.send(MERCHANT, h.agent.deps.builders.withdrawal({ withdrawal: (await h.agent.deps.store.getWithdrawal(w.id))!, merchant: (await h.agent.deps.store.getMerchant("ahseng"))!, destinationLabel: "DBS ••••1234", sessionToken: "t" }));
    h.clear();
    await h.emit({ type: "withdrawal.updated", withdrawalId: w.id, merchantId: "ahseng", status, amount: money("5.00", "SGD") });
    assert.equal(h.sentTo(MERCHANT.phone, "card-edit:withdrawal").length, 1);
    assert.equal(h.texts(MERCHANT.phone).length, 0);
  });
}

test("withdrawal.updated completed (bank): settles the action, one 'in your bank' text with the ref", async () => {
  const h = makeHarness();
  await addBank(h);
  const w = await h.agent.deps.worker.createWithdrawal({ merchantId: "ahseng", amount: "5.00", destination: null });
  const action = await h.agent.deps.store.insertAction({ merchantId: "ahseng", kind: "withdrawal", args: { kind: "withdrawal", withdrawalId: w.id }, expiresAt: new Date(h.now().getTime() + 60_000).toISOString() });
  await h.agent.deps.store.claimAction(action.id);
  h.clear();
  await h.emit({ type: "withdrawal.updated", withdrawalId: w.id, merchantId: "ahseng", status: "completed", amount: money("5.00", "SGD"), bankRef: "FAST-123456" });
  assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "done");
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /S\$5\.00 is in your bank/);
  assert.match(t[0]!, /FAST-123456/);
});

test("withdrawal.updated onchain_settled (wallet): treated as done, 'wallet' text", async () => {
  const h = makeHarness();
  const w = await h.agent.deps.worker.createWithdrawal({ merchantId: "ahseng", amount: "5.00", destination: { kind: "xrpl_wallet", address: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" } });
  h.clear();
  await h.emit({ type: "withdrawal.updated", withdrawalId: w.id, merchantId: "ahseng", status: "onchain_settled", amount: money("5.00", "SGD") });
  const t = h.texts(MERCHANT.phone);
  assert.equal(t.length, 1);
  assert.match(t[0]!, /wallet/);
  const card = h.sentTo(MERCHANT.phone, "card");
  assert.equal(card.length, 1);
  assert.match(card[0]!.body, /rPEP…GDY/);
});

for (const status of ["failed", "returned", "cancelled"] as const) {
  test(`withdrawal.updated ${status}: action failed, one 'money's back' text`, async () => {
    const h = makeHarness();
    await addBank(h);
    const w = await h.agent.deps.worker.createWithdrawal({ merchantId: "ahseng", amount: "5.00", destination: null });
    const action = await h.agent.deps.store.insertAction({ merchantId: "ahseng", kind: "withdrawal", args: { kind: "withdrawal", withdrawalId: w.id }, expiresAt: new Date(h.now().getTime() + 60_000).toISOString() });
    await h.agent.deps.store.claimAction(action.id);
    h.clear();
    await h.emit({ type: "withdrawal.updated", withdrawalId: w.id, merchantId: "ahseng", status, amount: money("5.00", "SGD"), failureReason: "Account closed" });
    assert.equal((await h.agent.deps.store.getAction(action.id))!.status, "failed");
    const t = h.texts(MERCHANT.phone);
    assert.equal(t.length, 1);
    assert.match(t[0]!, /Account closed/);
    assert.match(t[0]!, /back in your balance/);
  });
}

test("withdrawal.updated for an unknown withdrawal still edits a card from the event (no throw)", async () => {
  const h = makeHarness();
  await h.emit({ type: "withdrawal.updated", withdrawalId: "wd_ghost", merchantId: "ahseng", status: "completed", amount: money("3.00", "SGD") });
  assert.equal(h.sentTo(MERCHANT.phone, "card:withdrawal").length, 1);
  assert.equal(h.texts(MERCHANT.phone).length, 1);
});

test("merchant.live (not onboarding): confetti + shop link fallback + bank card", async () => {
  const h = makeHarness();
  await h.emit({ type: "merchant.live", merchantId: "ahseng", xrplAddress: "rX" });
  assert.equal(h.sentTo(MERCHANT.phone, "effect").length, 1);
  assert.equal(h.texts(MERCHANT.phone).length, 1, "sticker falls back to one link text");
  assert.match(h.texts(MERCHANT.phone)[0]!, /pay ahseng/);
  assert.equal(h.sentTo(MERCHANT.phone, "card:bank").length, 1);
});

test("shop.updated (not onboarding): setup card update; bank_account.added: one line", async () => {
  const h = makeHarness();
  await h.emit({ type: "shop.updated", merchantId: "ahseng", fields: ["menu"] });
  assert.equal(h.sentTo(MERCHANT.phone, "card").length, 1);
  assert.equal(h.sentTo(MERCHANT.phone, "card")[0]!.card!.kind, "setup");
  h.clear();
  await h.emit({ type: "bank_account.added", merchantId: "ahseng", bankAccountId: "bank_1", label: "DBS ••••1234 (AH SENG)" });
  assert.deepEqual(h.texts(MERCHANT.phone).length, 1);
  assert.match(h.texts(MERCHANT.phone)[0]!, /DBS ••••1234/);
});

test("events for unknown merchants / payments don't throw and send nothing", async () => {
  const h = makeHarness();
  const events = [
    { type: "payment.settled", paymentId: "pay_x", merchantId: "ghost", source: "invoice", invoiceId: null, local: money("1.00", "SGD"), payer: null, txHash: "0", delivered: "1", firstSale: false },
    { type: "payment.settled", paymentId: "pay_missing", merchantId: "ahseng", source: "invoice", invoiceId: null, local: money("1.00", "SGD"), payer: null, txHash: "0", delivered: "1", firstSale: false },
    { type: "payment.failed", paymentId: "pay_x", merchantId: "ghost", reason: "x" },
    { type: "refund.completed", refundId: "r", paymentId: "pay_x", merchantId: "ghost", actionId: "a", amount: money("1.00", "SGD"), payer: null },
    { type: "refund.failed", refundId: "r", paymentId: "pay_x", merchantId: "ghost", actionId: "a", reason: "x" },
    { type: "withdrawal.updated", withdrawalId: "wd_x", merchantId: "ghost", status: "completed", amount: money("1.00", "SGD") },
    { type: "merchant.live", merchantId: "ghost", xrplAddress: "r" },
    { type: "shop.updated", merchantId: "ghost", fields: ["name"] },
    { type: "bank_account.added", merchantId: "ghost", bankAccountId: "b", label: "x" },
  ] as const;
  for (const e of events) assert.equal(await h.emit(e as never), "handled");
  assert.equal(h.record.length, 0);
});

test("a failing send doesn't stop the rest of the handler", async () => {
  const h = makeHarness();
  const cards = h.agent.deps.outbox.cards;
  const origSend = cards.send.bind(cards);
  cards.send = async (to, spec) => {
    if (spec.kind === "sale") throw new Error("photon down");
    return origSend(to, spec);
  };
  const p = await h.agent.deps.store.mock!.payInvoice("M4YA22", CUSTOMER);
  h.clear();
  await h.emit({ type: "payment.settled", paymentId: p.id, merchantId: "ahseng", source: "invoice", invoiceId: p.invoiceId, local: p.local, payer: CUSTOMER, txHash: "0", delivered: "6.5", firstSale: true });
  assert.equal(h.sentTo(MERCHANT.phone, "effect").length, 1, "confetti still sent");
  assert.equal(h.sentTo(CUSTOMER.phone, "card:receipt").length, 1, "receipt still sent");
});

test("a duplicate envelope id is ignored", async () => {
  const h = makeHarness();
  const e = { type: "bank_account.added", merchantId: "ahseng", bankAccountId: "b", label: "DBS ••••1" } as const;
  assert.equal(await h.emit(e, "evt_same"), "handled");
  assert.equal(await h.emit(e, "evt_same"), "duplicate");
  assert.equal(h.texts(MERCHANT.phone).length, 1);
});

void (null as unknown as Withdrawal);
