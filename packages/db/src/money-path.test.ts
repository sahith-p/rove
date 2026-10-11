// NI-B1 "done when": a payment walks created → authorized → settling → settled and withdrawals walk every path
// (completed, failed before chain, returned), with getBalance checked at each step (withdrawals.md §1).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DbConflictError, type Db } from "./index";
import type { Pool } from "./executor";
import { amounts, liveMerchant, openTestDb, paymentInput, settle, sgd, usd } from "./testkit";
import { DEMO_CUSTOMER } from "@rove/shared/mocks";

let db: Db;
let pool: Pool;
before(async () => ({ db, pool } = await openTestDb()));
after(() => db.close());

const ledgerRows = async (ref: string) =>
  (await pool.query<{ kind: string; amount: string }>(`select kind, amount::text from ledger_entries where ref = $1 order by created_at`, [ref])).map(
    (r) => `${r.kind}:${r.amount}`,
  );

describe("payment: created → authorized → settling → settled", () => {
  it("credits the ledger once, pays the invoice, adds the payer, flags the first sale", async () => {
    const m = await liveMerchant(db, "walk");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["0.00", "0.00", "0.00"]);

    const inv = await db.createInvoice({
      merchantId: m.id,
      kind: "invoice",
      to: { phone: DEMO_CUSTOMER.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 $1 $2 $3"), channel: "imessage" },
      lines: [
        { menuItemId: null, name: "Chicken rice", qty: 2, unit: sgd("5.50") },
        { menuItemId: null, name: "Barley drink", qty: 1, unit: sgd("1.50") },
      ],
      total: sgd("12.50"),
    });
    const p = paymentInput(m.id, sgd("12.50"), {
      source: "invoice",
      invoiceId: inv.id,
      lines: inv.lines,
      payer: inv.to,
      stripePaymentIntentId: "pi_walk",
    });

    const created = await db.insertPayment(p);
    assert.equal(created.status, "created");
    assert.deepEqual(created.charge, usd("9.72"));
    assert.equal(created.quote?.rate, "1.286");
    assert.equal(created.quote?.sendMaxUsd, "9.79");
    assert.deepEqual(created.refunded, sgd("0"));
    assert.equal((await db.getPaymentByStripePI("pi_walk"))?.id, p.id);

    const authorized = await db.transitionPayment(p.id, ["created"], "authorized", { method: "apple_pay" });
    assert.equal(authorized?.status, "authorized");
    assert.equal(authorized?.method, "apple_pay");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["0.00", "0.00", "0.00"]);

    const settling = await db.transitionPayment(p.id, ["authorized"], "settling");
    assert.equal(settling?.status, "settling");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["0.00", "0.00", "0.00"]);

    const done = await db.completeSettlement(p.id, { txHash: "ABC123", delivered: "12.5" });
    assert.ok(done);
    assert.equal(done.firstSale, true);
    assert.equal(done.payment.status, "settled");
    assert.equal(done.payment.settleTxHash, "ABC123");
    assert.equal(done.payment.deliveredAmount, "12.50");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["12.50", "0.00", "12.50"]);

    const paid = await db.getInvoice(inv.id);
    assert.equal(paid?.status, "paid");
    assert.equal(paid?.paymentId, p.id);
    const contacts = await db.findContacts(m.id);
    assert.deepEqual(
      contacts.map((c) => [c.phone, c.channel]),
      [[DEMO_CUSTOMER.phone, "imessage"]],
    );

    // idempotent: a second completion is a CAS miss and writes nothing
    assert.equal(await db.completeSettlement(p.id, { txHash: "ABC123", delivered: "12.50" }), null);
    assert.deepEqual(await ledgerRows(p.id), ["payment_credit:12.50"]);
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["12.50", "0.00", "12.50"]);

    // the second sale isn't the first
    const second = await settle(db, paymentInput(m.id, sgd("20.00")));
    assert.equal(second.firstSale, false);
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["32.50", "0.00", "32.50"]);

    const today = await db.daySummary(m.id, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
    assert.equal(today.count, 2);
    assert.deepEqual(today.gross, sgd("32.50"));
    assert.equal(today.openInvoices, 0);
    const yesterday = await db.daySummary(m.id, "2000-01-01");
    assert.equal(yesterday.count, 0);
    assert.deepEqual(yesterday.gross, sgd("0"));
  });

  it("completeSettlement on a payment that isn't settling (or doesn't exist) returns null", async () => {
    const m = await liveMerchant(db, "notsettling");
    const p = paymentInput(m.id, sgd("3.00"));
    await db.insertPayment(p);
    assert.equal(await db.completeSettlement(p.id, { txHash: "X", delivered: "3.00" }), null);
    assert.equal(await db.completeSettlement("pay_missing", { txHash: "X", delivered: "3.00" }), null);
    assert.deepEqual(await ledgerRows(p.id), []);
  });
});

describe("withdrawals: every path, balance at each step", () => {
  it("completed (hold → debit), failed before chain (hold → release), returned (hold → debit → return)", async () => {
    const m = await liveMerchant(db, "wd");
    await settle(db, paymentInput(m.id, sgd("12.50")));
    await settle(db, paymentInput(m.id, sgd("20.00")));
    const bank = await db.insertBankAccount({
      merchantId: m.id,
      type: "bank_account",
      bankName: "DBS/POSB",
      last4: "1234",
      holderName: "AH SENG FOOD PTE LTD",
      beneficiaryId: "ben_1",
      status: "verified",
    });
    const bal = async () => amounts(await db.getBalance(m.id));
    assert.deepEqual(await bal(), ["32.50", "0.00", "32.50"]);

    // --- completed: requested → approved (hold) → onchain_pending → onchain_settled (debit) → payout_pending → completed
    const a = await db.insertWithdrawal({
      merchantId: m.id,
      amount: sgd("10.00"),
      fee: sgd("0"),
      destination: { kind: "bank", bankAccountId: bank.id },
      needsStepUp: true,
    });
    assert.equal(a.status, "requested");
    assert.deepEqual(a.destination, { kind: "bank", bankAccountId: bank.id });
    assert.deepEqual(await bal(), ["32.50", "0.00", "32.50"]); // requesting moves nothing

    const approved = await db.approveWithdrawal(a.id, "act_a");
    assert.equal(approved.ok, true);
    assert.equal(approved.withdrawal?.status, "approved");
    assert.deepEqual(await bal(), ["22.50", "10.00", "32.50"]);

    assert.equal((await db.transitionWithdrawal(a.id, ["approved"], "onchain_pending"))?.status, "onchain_pending");
    const onchain = await db.transitionWithdrawal(a.id, ["onchain_pending"], "onchain_settled", { sweepTxHash: "SWEEP_A" });
    assert.equal(onchain?.sweepTxHash, "SWEEP_A");
    assert.equal(await db.appendLedger({ merchantId: m.id, kind: "withdrawal_debit", amount: sgd("10.00"), ref: a.id }), true);
    assert.equal(await db.appendLedger({ merchantId: m.id, kind: "withdrawal_debit", amount: sgd("10.00"), ref: a.id }), false);
    assert.deepEqual(await bal(), ["22.50", "0.00", "22.50"]);

    await db.transitionWithdrawal(a.id, ["onchain_settled"], "payout_pending", { partnerPayoutId: "po_1" });
    assert.equal(await db.hasCompletedWithdrawal(m.id), false);
    const completed = await db.transitionWithdrawal(a.id, ["payout_pending"], "completed", { bankRef: "FAST-881245" });
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.bankRef, "FAST-881245");
    assert.equal(completed?.partnerPayoutId, "po_1");
    assert.equal(await db.hasCompletedWithdrawal(m.id), true);
    assert.deepEqual(await bal(), ["22.50", "0.00", "22.50"]);
    assert.deepEqual(await ledgerRows(a.id), ["withdrawal_hold:10.00", "withdrawal_debit:10.00"]);

    // --- failed before chain: approved (hold) → failed (release)
    const b = await db.insertWithdrawal({
      merchantId: m.id,
      amount: sgd("5.00"),
      fee: sgd("0"),
      destination: { kind: "xrpl_wallet", address: "rP4xExampleWalletAddress1234" },
      needsStepUp: false,
    });
    assert.deepEqual(b.destination, { kind: "xrpl_wallet", address: "rP4xExampleWalletAddress1234" });
    assert.equal((await db.approveWithdrawal(b.id, "act_b")).ok, true);
    assert.deepEqual(await bal(), ["17.50", "5.00", "22.50"]);
    const failed = await db.transitionWithdrawal(b.id, ["approved", "onchain_pending"], "failed", { failureReason: "tecPATH_DRY" });
    assert.equal(failed?.failureReason, "tecPATH_DRY");
    await db.appendLedger({ merchantId: m.id, kind: "withdrawal_release", amount: sgd("5.00"), ref: b.id });
    assert.deepEqual(await bal(), ["22.50", "0.00", "22.50"]);
    assert.deepEqual(await ledgerRows(b.id), ["withdrawal_hold:5.00", "withdrawal_release:5.00"]);

    // --- returned: approved (hold) → onchain_settled (debit) → payout_pending → returned (return)
    const c = await db.insertWithdrawal({
      merchantId: m.id,
      amount: sgd("7.00"),
      fee: sgd("0"),
      destination: { kind: "bank", bankAccountId: bank.id },
      needsStepUp: false,
    });
    assert.equal((await db.approveWithdrawal(c.id, "act_c")).ok, true);
    assert.deepEqual(await bal(), ["15.50", "7.00", "22.50"]);
    await db.transitionWithdrawal(c.id, ["approved"], "onchain_pending");
    await db.transitionWithdrawal(c.id, ["onchain_pending"], "onchain_settled", { sweepTxHash: "SWEEP_C" });
    await db.appendLedger({ merchantId: m.id, kind: "withdrawal_debit", amount: sgd("7.00"), ref: c.id });
    assert.deepEqual(await bal(), ["15.50", "0.00", "15.50"]);
    await db.transitionWithdrawal(c.id, ["onchain_settled"], "payout_pending", { partnerPayoutId: "po_3" });
    assert.equal((await db.transitionWithdrawal(c.id, ["payout_pending"], "returned", { failureReason: "account closed" }))?.status, "returned");
    await db.appendLedger({ merchantId: m.id, kind: "withdrawal_return", amount: sgd("7.00"), ref: c.id });
    assert.deepEqual(await bal(), ["22.50", "0.00", "22.50"]);
    assert.deepEqual(await ledgerRows(c.id), ["withdrawal_hold:7.00", "withdrawal_debit:7.00", "withdrawal_return:7.00"]);

    // reporting
    assert.deepEqual(await db.withdrawnToday(m.id), sgd("17.00")); // completed 10 + returned 7; failed doesn't count
    assert.deepEqual(
      (await db.listWithdrawals(m.id)).map((w) => w.status).sort(),
      ["completed", "failed", "returned"],
    );
    assert.deepEqual(
      (await db.listWithdrawalsByStatus(["completed", "returned"])).filter((w) => w.merchantId === m.id).map((w) => w.id),
      [a.id, c.id],
    );
  });

  it("a CAS from the wrong status returns null", async () => {
    const m = await liveMerchant(db, "wdcas");
    const w = await db.insertWithdrawal({ merchantId: m.id, amount: sgd("1.00"), fee: sgd("0"), destination: { kind: "xrpl_wallet", address: "rX" }, needsStepUp: false });
    assert.equal(await db.transitionWithdrawal(w.id, ["approved"], "onchain_pending"), null);
    assert.equal((await db.transitionWithdrawal(w.id, ["requested"], "cancelled"))?.status, "cancelled");
    assert.equal(await db.transitionWithdrawal(w.id, ["requested"], "cancelled"), null);
    assert.equal(await db.transitionWithdrawal("wd_missing", ["requested"], "cancelled"), null);
  });
});

describe("approveWithdrawal", () => {
  it("refuses more than is available and leaves the withdrawal requested", async () => {
    const m = await liveMerchant(db, "poor");
    await settle(db, paymentInput(m.id, sgd("4.00")));
    const w = await db.insertWithdrawal({ merchantId: m.id, amount: sgd("5.00"), fee: sgd("0"), destination: { kind: "xrpl_wallet", address: "rX" }, needsStepUp: false });
    const r = await db.approveWithdrawal(w.id, "act_poor");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "insufficient_funds");
    assert.equal(r.withdrawal?.status, "requested");
    assert.equal((await db.getWithdrawal(w.id))?.status, "requested");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["4.00", "0.00", "4.00"]);
  });

  it("is single-shot: a second approval is not_requested; unknown ids too", async () => {
    const m = await liveMerchant(db, "twice");
    await settle(db, paymentInput(m.id, sgd("10.00")));
    const w = await db.insertWithdrawal({ merchantId: m.id, amount: sgd("3.00"), fee: sgd("0"), destination: { kind: "xrpl_wallet", address: "rX" }, needsStepUp: false });
    assert.equal((await db.approveWithdrawal(w.id, "act_t1")).ok, true);
    const again = await db.approveWithdrawal(w.id, "act_t2");
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.reason, "not_requested");
    assert.equal(again.withdrawal?.status, "approved");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["7.00", "3.00", "10.00"]); // one hold only
    const missing = await db.approveWithdrawal("wd_missing", "act_t3");
    assert.deepEqual(missing, { ok: false, reason: "not_requested", withdrawal: null });
  });

  it("two withdrawals that each fit but not together: only one is approved", async () => {
    const m = await liveMerchant(db, "race");
    await settle(db, paymentInput(m.id, sgd("10.00")));
    const mk = (amount: string) =>
      db.insertWithdrawal({ merchantId: m.id, amount: sgd(amount), fee: sgd("0"), destination: { kind: "xrpl_wallet", address: "rX" }, needsStepUp: false });
    const [w1, w2] = await Promise.all([mk("7.00"), mk("6.00")]);
    const results = await Promise.all([db.approveWithdrawal(w1.id, "act_r1"), db.approveWithdrawal(w2.id, "act_r2")]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const loser = results.find((r) => !r.ok)!;
    assert.equal(!loser.ok && loser.reason, "insufficient_funds");
    const won = results.find((r) => r.ok)!.withdrawal!;
    const b = await db.getBalance(m.id);
    assert.deepEqual(b.held, won.amount);
    assert.deepEqual(b.total, sgd("10.00"));
  });
});

describe("payment CAS", () => {
  it("a second transition from the wrong status returns null", async () => {
    const m = await liveMerchant(db, "cas");
    const p = paymentInput(m.id, sgd("6.50"));
    await db.insertPayment(p);
    assert.equal((await db.transitionPayment(p.id, ["created"], "authorized"))?.status, "authorized");
    assert.equal(await db.transitionPayment(p.id, ["created"], "authorized"), null);
    assert.equal(await db.transitionPayment(p.id, ["settling"], "settled"), null);
    assert.equal(await db.transitionPayment("pay_missing", ["created"], "authorized"), null);
    const failed = await db.transitionPayment(p.id, ["authorized", "settling"], "failed", { failureReason: "no path" });
    assert.equal(failed?.status, "failed");
  });

  it("a second authorization for the same invoice throws DbConflictError(payments_one_per_invoice)", async () => {
    const m = await liveMerchant(db, "dup");
    const inv = await db.createInvoice({
      merchantId: m.id,
      kind: "one_time_qr",
      lines: [{ menuItemId: null, name: "Payment", qty: 1, unit: sgd("6.50") }],
      total: sgd("6.50"),
    });
    const p1 = paymentInput(m.id, sgd("6.50"), { source: "one_time_qr", invoiceId: inv.id });
    const p2 = paymentInput(m.id, sgd("6.50"), { source: "one_time_qr", invoiceId: inv.id });
    await db.insertPayment(p1);
    await db.insertPayment(p2); // two checkouts may exist; only one may get through
    assert.ok(await db.transitionPayment(p1.id, ["created"], "authorized"));
    await assert.rejects(
      () => db.transitionPayment(p2.id, ["created"], "authorized"),
      (e: unknown) => e instanceof DbConflictError && e.constraint === "payments_one_per_invoice",
    );
    assert.equal((await db.getPayment(p2.id))?.status, "created");
    // the loser can still be failed
    assert.equal((await db.transitionPayment(p2.id, ["created"], "failed", { failureReason: "invoice already paid" }))?.status, "failed");
  });

  it("finds payments by deposit address (case-insensitive) and by status", async () => {
    const m = await liveMerchant(db, "bnb");
    const p = paymentInput(m.id, sgd("8.00"), { method: "bnb", bnbDepositAddress: "0xAbCdEf0000000000000000000000000000000001" });
    await db.insertPayment(p);
    assert.equal((await db.getPaymentByDepositAddress("0xabcdef0000000000000000000000000000000001"))?.id, p.id);
    await db.transitionPayment(p.id, ["created"], "authorized", { payinTxHash: "0xhash" });
    assert.ok((await db.listPaymentsByStatus(["authorized"])).some((x) => x.id === p.id));
    assert.deepEqual((await db.listPayments(m.id)).map((x) => x.id), [p.id]);
    assert.equal(await db.nextDepositIndex(), 1);
    assert.equal(await db.nextDepositIndex(), 2);
  });
});

describe("refunds", () => {
  it("addPaymentRefund: partial → full, never more than paid; insertRefund is idempotent on the action", async () => {
    const m = await liveMerchant(db, "refund");
    const { payment } = await settle(db, paymentInput(m.id, sgd("12.50"), { payer: { phone: "+6591112222", channel: "whatsapp" } }));

    const r1 = await db.insertRefund({ paymentId: payment.id, merchantId: m.id, actionId: "act_ref1", amount: sgd("5.00") });
    const r1again = await db.insertRefund({ paymentId: payment.id, merchantId: m.id, actionId: "act_ref1", amount: sgd("5.00") });
    assert.equal(r1again.id, r1.id);
    assert.equal(r1.status, "pending");
    assert.equal((await db.getRefundByAction("act_ref1"))?.id, r1.id);

    await db.appendLedger({ merchantId: m.id, kind: "refund_debit", amount: sgd("5.00"), ref: r1.id });
    const partial = await db.addPaymentRefund(payment.id, sgd("5.00"));
    assert.equal(partial?.status, "partially_refunded");
    assert.deepEqual(partial?.refunded, sgd("5.00"));
    const updated = await db.updateRefund(r1.id, { status: "completed", stripeRefundId: "re_1", xrplTxHash: "XRPLTX" });
    assert.equal(updated?.status, "completed");
    assert.equal(updated?.stripeRefundId, "re_1");
    assert.deepEqual(amounts(await db.getBalance(m.id)), ["7.50", "0.00", "7.50"]);

    assert.equal(await db.addPaymentRefund(payment.id, sgd("7.51")), null); // more than what's left
    const full = await db.addPaymentRefund(payment.id, sgd("7.50"));
    assert.equal(full?.status, "refunded");
    assert.deepEqual(full?.refunded, sgd("12.50"));
    assert.equal(await db.addPaymentRefund(payment.id, sgd("0.01")), null);

    const today = await db.daySummary(m.id, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
    assert.deepEqual([today.gross, today.refunded, today.net], [sgd("12.50"), sgd("5.00"), sgd("7.50")]);
    assert.deepEqual((await db.receiptsForPhone("+65 9111 2222")).map((p) => p.id), [payment.id]);
  });
});
