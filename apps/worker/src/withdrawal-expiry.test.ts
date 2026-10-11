// NI-C7 · requested withdrawals past their confirmation window → cancelled (PGlite).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money, PENDING_ACTION_TTL_MS } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import { createKit, liveMerchant, NO_TEST_DB, testDbAvailable } from "./settle/testkit";
import { EXPIRED_REQUEST_REASON, expireWithdrawalRequests, startWithdrawalExpiryJob, WITHDRAWAL_REQUEST_TTL_MS } from "./withdrawal-expiry";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;
const sgd = (a: string) => money(a, "SGD");

const request = (deps: WorkerDeps, amount: string) =>
  deps.db.insertWithdrawal({
    merchantId: "ahseng",
    amount: sgd(amount),
    fee: sgd("0.00"),
    destination: { kind: "xrpl_wallet", address: "rWALLETxxxxxxxxxxxxxxxxxxxxxxxxxx" },
    needsStepUp: false,
  });

/** deps whose clock is `ms` ahead of the database's now(). */
const later = (deps: WorkerDeps, ms: number): WorkerDeps => ({ ...deps, now: () => new Date(Date.now() + ms) });

describe("withdrawal request expiry", { skip }, () => {
  test("the window is the pending action's TTL plus a minute", () => {
    assert.equal(WITHDRAWAL_REQUEST_TTL_MS, PENDING_ACTION_TTL_MS + 60_000);
  });

  test("cancels requested withdrawals past the window; they stop counting toward the daily limit", async (t) => {
    const { deps, logs } = await createKit(t);
    await liveMerchant(deps);
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("100.00"), ref: "pay_a" });
    const stale = await request(deps, "40.00");
    assert.deepEqual(await deps.db.withdrawnToday("ahseng"), sgd("40.00"));

    const cancelled = await expireWithdrawalRequests(later(deps, WITHDRAWAL_REQUEST_TTL_MS + 1000));

    assert.deepEqual(
      cancelled.map((w) => w.id),
      [stale.id],
    );
    const row = (await deps.db.getWithdrawal(stale.id))!;
    assert.equal(row.status, "cancelled");
    assert.equal(row.failureReason, EXPIRED_REQUEST_REASON);
    assert.deepEqual(await deps.db.withdrawnToday("ahseng"), sgd("0.00"));
    // Nothing was held, so nothing changes in the ledger, and the agent isn't told (it expired the action itself).
    assert.deepEqual(await deps.db.getBalance("ahseng"), { available: sgd("100.00"), held: sgd("0.00"), total: sgd("100.00") });
    assert.deepEqual(deps.events, []);
    assert.ok(logs.some((l) => l.includes("withdrawal request expired → cancelled") && l.includes("S$40.00") && l.includes(stale.id)));

    assert.deepEqual(await expireWithdrawalRequests(later(deps, WITHDRAWAL_REQUEST_TTL_MS + 1000)), [], "second pass: nothing left");
  });

  test("leaves requests still inside the window, and anything already approved", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("100.00"), ref: "pay_a" });
    const fresh = await request(deps, "10.00");
    const approved = await request(deps, "20.00");
    assert.equal((await deps.db.approveWithdrawal(approved.id, "act_1")).ok, true);

    // Just inside the window for `fresh`; long past it for `approved`, which isn't `requested` any more.
    assert.deepEqual(await expireWithdrawalRequests(later(deps, PENDING_ACTION_TTL_MS)), []);
    assert.deepEqual(await expireWithdrawalRequests(later(deps, 24 * 3600_000)).then((ws) => ws.map((w) => w.id)), [fresh.id]);
    assert.equal((await deps.db.getWithdrawal(approved.id))?.status, "approved");
    assert.deepEqual((await deps.db.getBalance("ahseng")).held, sgd("20.00"));
  });

  test("a confirmation that wins the race keeps its withdrawal (CAS)", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("50.00"), ref: "pay_a" });
    const w = await request(deps, "5.00");
    const real = deps.db.listWithdrawalsByStatus.bind(deps.db);
    deps.db.listWithdrawalsByStatus = async (statuses) => {
      const rows = await real(statuses);
      await deps.db.approveWithdrawal(w.id, "act_race"); // approved after the job listed it, before its CAS
      return rows;
    };
    assert.deepEqual(await expireWithdrawalRequests(later(deps, WITHDRAWAL_REQUEST_TTL_MS + 1000)), []);
    assert.equal((await deps.db.getWithdrawal(w.id))?.status, "approved");
  });

  test("startWithdrawalExpiryJob runs right away and stops", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    await deps.db.appendLedger({ merchantId: "ahseng", kind: "payment_credit", amount: sgd("50.00"), ref: "pay_a" });
    const w = await request(deps, "5.00");
    const stop = startWithdrawalExpiryJob(later(deps, WITHDRAWAL_REQUEST_TTL_MS + 1000));
    await new Promise((r) => setTimeout(r, 120));
    stop();
    assert.equal((await deps.db.getWithdrawal(w.id))?.status, "cancelled");
  });
});
