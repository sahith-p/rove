// NI-C4 · the withdrawal pipeline (withdrawals.md §3c, docs/06-testing.md §3). Real SQL via createTestDeps(), the
// sleep-free engine from testkit.ts, and the mock payout partner (callbacks after 20ms) unless a test swaps it.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { money, type WithdrawalStatus } from "@rove/shared";
import { isUserFacingError } from "../errors";
import { createServer } from "../server";
import { TEST_INTERNAL_SECRET } from "../testing";
import { createWithdrawal } from "./create";
import { executeWithdrawal, resumeWithdrawals } from "./execute";
import { idle } from "./lock";
import { handlePartnerUpdate, startPartnerCallbacks } from "./partner";
import { NO_TRUST_LINE_REASON, ONCHAIN_FAILED_REASON, RETURNED_REASON } from "./pipeline";
import {
  closeFixtures,
  createCountingPartner,
  createSilentPartner,
  dbSkipReason,
  statusTrail,
  waitForStatus,
  withdrawalFixture,
  type WithdrawalFixture,
} from "./testkit";

const skip = await dbSkipReason();
const WALLET = "rP4xQnF1mGkS8TzQvB2cWdK7Y9Kd";
const BANK_PATH: WithdrawalStatus[] = ["approved", "onchain_pending", "onchain_settled", "payout_pending", "completed"];

async function requested(fx: WithdrawalFixture, amount: string | null, destination: { kind: "xrpl_wallet"; address: string } | null = null) {
  return createWithdrawal(fx.deps, { merchantId: fx.merchantId, amount, destination });
}

/** Every status announced while the ledger agreed with the chain. */
function assertReconciledThroughout(fx: WithdrawalFixture) {
  assert.ok(fx.snapshots.length > 0, "no withdrawal.updated seen");
  for (const s of fx.snapshots) assert.ok(s.ok, `ledger != chain at ${s.status}: ${JSON.stringify(s)}`);
}

async function balance(fx: WithdrawalFixture) {
  const b = await fx.deps.db.getBalance(fx.merchantId);
  return { available: b.available.amount, held: b.held.amount };
}

describe("withdrawal pipeline (NI-C4)", { skip }, () => {
  after(closeFixtures);

  test("bank: requested → … → completed; available −amount, held 0, ledger = chain at every step", async () => {
    const counting = createCountingPartner();
    const fx = await withdrawalFixture({ balance: "118.40", payouts: counting.partner });
    const stop = startPartnerCallbacks(fx.deps);
    try {
      const v = await requested(fx, "100");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });

      const done = await waitForStatus(fx.deps, v.id, ["completed"]);
      await idle(v.id);
      assert.deepEqual(statusTrail(fx.deps, v.id), BANK_PATH);
      assert.match(done.bankRef ?? "", /^FAST-\d{6}$/);
      assert.ok(done.sweepTxHash);
      assert.ok(done.partnerPayoutId);
      assert.deepEqual(await balance(fx), { available: "18.40", held: "0.00" });
      assert.equal(fx.fast.balanceOf(fx.address).amount, "18.40");
      assertReconciledThroughout(fx);
      assert.deepEqual(
        fx.snapshots.map((s) => [s.status, s.available, s.held]),
        [
          ["approved", "18.40", "100.00"],
          ["onchain_pending", "18.40", "100.00"],
          ["onchain_settled", "18.40", "0.00"],
          ["payout_pending", "18.40", "0.00"],
          ["completed", "18.40", "0.00"],
        ],
      );
      assert.equal(fx.fast.calls.sweepToRedemption, 1);
      assert.equal(counting.calls.createPayout, 1);

      const last = fx.deps.events.at(-1)!;
      assert.equal(last.type, "withdrawal.updated");
      if (last.type === "withdrawal.updated") {
        assert.deepEqual(last.amount, { amount: "100.00", currency: "SGD" });
        assert.equal(last.bankRef, done.bankRef);
        assert.equal(last.sweepTxHash, done.sweepTxHash);
        assert.equal(last.merchantId, fx.merchantId);
      }
    } finally {
      stop();
    }
  });

  test("MOCK_PAYOUT_FAIL=1 → returned: XSGD re-sent from the treasury float, withdrawal_return re-credits", async () => {
    const fx = await withdrawalFixture({ balance: "50" });
    const stop = startPartnerCallbacks(fx.deps);
    const settleInputs: unknown[] = [];
    const settle = fx.fast.engine.settle;
    fx.fast.engine.settle = async (input) => {
      settleInputs.push(input);
      return settle(input);
    };
    process.env.MOCK_PAYOUT_FAIL = "1";
    try {
      const v = await requested(fx, "30");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      const w = await waitForStatus(fx.deps, v.id, ["returned", "completed", "failed"]);
      await idle(v.id);
      assert.equal(w.status, "returned");
      assert.equal(w.failureReason, RETURNED_REASON);
      assert.equal(RETURNED_REASON, "Bank rejected it; the money is back in your balance");
      assert.deepEqual(statusTrail(fx.deps, v.id), ["approved", "onchain_pending", "onchain_settled", "payout_pending", "returned"]);
      assert.deepEqual(settleInputs, [{ paymentId: v.id, merchantAddress: fx.address, local: money("30", "SGD"), sendMaxUsd: "0", from: "SGD" }]);
      assert.deepEqual(await balance(fx), { available: "50.00", held: "0.00" });
      assert.equal(fx.fast.balanceOf(fx.address).amount, "50.00");
      assertReconciledThroughout(fx);
      const ev = fx.deps.events.at(-1)!;
      assert.ok(ev.type === "withdrawal.updated" && ev.failureReason === RETURNED_REASON);
    } finally {
      delete process.env.MOCK_PAYOUT_FAIL;
      stop();
    }
  });

  test("return transfer failing leaves it in payout_pending (no ledger change); a later poll finishes it", async () => {
    const silent = createSilentPartner();
    const fx = await withdrawalFixture({ balance: "50", payouts: silent.partner });
    const v = await requested(fx, "30");
    await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
    await waitForStatus(fx.deps, v.id, ["payout_pending"]);
    await idle(v.id);

    silent.decide(v.id, { status: "failed", failureReason: "Account closed" });
    fx.fast.fail.settle = new Error("treasury float empty");
    const w = (await fx.deps.db.getWithdrawal(v.id))!;
    // Retries back off 0.5s + 2s; give it time.
    await handlePartnerUpdate(fx.deps, { partnerPayoutId: w.partnerPayoutId!, withdrawalId: v.id, status: "failed" });
    assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "payout_pending");
    assert.equal(fx.fast.calls.settle, 3);
    assert.deepEqual(await balance(fx), { available: "20.00", held: "0.00" });
    assert.ok(fx.logs.some((l) => l.level === "error" && l.line.includes("XSGD return failed")));

    fx.fast.fail.settle = null;
    await resumeWithdrawals(fx.deps);
    assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "returned");
    assert.deepEqual(await balance(fx), { available: "50.00", held: "0.00" });
    assert.ok((await fx.reconciled()).ok);
  });

  test("on-chain failure → failed, hold released, readable reason, no payout", async () => {
    const counting = createCountingPartner();
    const fx = await withdrawalFixture({ balance: "40", payouts: counting.partner });
    fx.fast.fail.onchain = new Error("tecUNFUNDED_PAYMENT");
    const v = await requested(fx, "25");
    await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
    const w = await waitForStatus(fx.deps, v.id, ["failed"]);
    await idle(v.id);
    assert.equal(w.failureReason, ONCHAIN_FAILED_REASON);
    assert.deepEqual(statusTrail(fx.deps, v.id), ["approved", "onchain_pending", "failed"]);
    assert.deepEqual(await balance(fx), { available: "40.00", held: "0.00" });
    assert.equal(counting.calls.createPayout, 0);
    assertReconciledThroughout(fx);
    const ev = fx.deps.events.at(-1)!;
    assert.ok(ev.type === "withdrawal.updated" && ev.failureReason === ONCHAIN_FAILED_REASON);
  });

  test("re-execute after completion is a no-op: one hold, one debit, one sweep, one payout", async () => {
    const counting = createCountingPartner();
    const fx = await withdrawalFixture({ balance: "60", payouts: counting.partner });
    const stop = startPartnerCallbacks(fx.deps);
    try {
      const v = await requested(fx, "60");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      await waitForStatus(fx.deps, v.id, ["completed"]);
      await idle(v.id);
      const events = fx.deps.events.length;

      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_other" });
      await idle(v.id);
      assert.equal(fx.deps.events.length, events, "no new events");
      assert.equal(fx.fast.calls.sweepToRedemption, 1);
      assert.equal(counting.calls.createPayout, 1);
      assert.deepEqual(await balance(fx), { available: "0.00", held: "0.00" });
      assert.ok((await fx.reconciled()).ok);
    } finally {
      stop();
    }
  });

  test("re-execute mid-flight queues behind the running step and repeats nothing", async () => {
    const counting = createCountingPartner();
    const fx = await withdrawalFixture({ balance: "60", payouts: counting.partner });
    const stop = startPartnerCallbacks(fx.deps);
    let release!: () => void;
    fx.fast.hold = new Promise((r) => (release = r));
    try {
      const v = await requested(fx, "45");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      await waitForStatus(fx.deps, v.id, ["onchain_pending"]);
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }); // returns right away (202)
      release();
      await waitForStatus(fx.deps, v.id, ["completed"]);
      await idle(v.id);
      assert.deepEqual(statusTrail(fx.deps, v.id), BANK_PATH);
      assert.equal(fx.fast.calls.sweepToRedemption, 1);
      assert.equal(counting.calls.createPayout, 1);
      assert.deepEqual(await balance(fx), { available: "15.00", held: "0.00" });
    } finally {
      stop();
    }
  });

  test("concurrent executes: exactly one pipeline", async () => {
    const counting = createCountingPartner();
    const fx = await withdrawalFixture({ balance: "80", payouts: counting.partner });
    const stop = startPartnerCallbacks(fx.deps);
    try {
      const v = await requested(fx, "80");
      await Promise.all([
        executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }),
        executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }),
        executeWithdrawal(fx.deps, v.id, { actionId: "act_2" }),
      ]);
      await waitForStatus(fx.deps, v.id, ["completed"]);
      await idle(v.id);
      assert.deepEqual(statusTrail(fx.deps, v.id), BANK_PATH);
      assert.equal(fx.fast.calls.sweepToRedemption, 1);
      assert.equal(counting.calls.createPayout, 1);
      assert.deepEqual(await balance(fx), { available: "0.00", held: "0.00" });
      assertReconciledThroughout(fx);
    } finally {
      stop();
    }
  });

  test("available dropped since the request → failed, no ledger change, 422 with the available amount", async () => {
    const fx = await withdrawalFixture({ balance: "60" });
    const v = await requested(fx, "50");
    // A refund went out in between.
    await fx.deps.db.appendLedger({ merchantId: fx.merchantId, kind: "refund_debit", amount: money("20", "SGD"), ref: "ref_1" });
    fx.fast.debit(fx.address, money("20", "SGD"));

    await assert.rejects(executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }), (err: unknown) => {
      assert.ok(isUserFacingError(err));
      assert.equal(err.code, "insufficient_funds");
      assert.equal(err.message, "You have S$40.00 available now, less than S$50.00, so nothing was withdrawn.");
      return true;
    });
    await idle(v.id);
    const w = await fx.deps.db.getWithdrawal(v.id);
    assert.equal(w?.status, "failed");
    assert.match(w?.failureReason ?? "", /S\$40\.00 available/);
    assert.deepEqual(statusTrail(fx.deps, v.id), ["failed"]);
    assert.deepEqual(await balance(fx), { available: "40.00", held: "0.00" });
    assert.equal(fx.fast.calls.sweepToRedemption, 0);
  });

  test("unknown id → 404; cancelled → 409", async () => {
    const fx = await withdrawalFixture({ balance: "60" });
    await assert.rejects(executeWithdrawal(fx.deps, "wd_nope", { actionId: "act_1" }), (err: unknown) => {
      assert.ok(isUserFacingError(err) && err.code === "withdrawal_not_found" && err.status === 404);
      return true;
    });
    const v = await requested(fx, "10");
    await fx.deps.db.transitionWithdrawal(v.id, ["requested"], "cancelled");
    await assert.rejects(executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }), (err: unknown) => {
      assert.ok(isUserFacingError(err) && err.code === "withdrawal_cancelled" && err.status === 409);
      return true;
    });
    assert.deepEqual(await balance(fx), { available: "60.00", held: "0.00" });
  });

  describe("wallet", () => {
    test("completes at onchain_settled; no payout", async () => {
      const counting = createCountingPartner();
      const fx = await withdrawalFixture({ balance: "20", bank: false, payouts: counting.partner });
      const v = await requested(fx, "5", { kind: "xrpl_wallet", address: WALLET });
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      const w = await waitForStatus(fx.deps, v.id, ["completed", "failed"]);
      await idle(v.id);
      assert.equal(w.status, "completed");
      assert.ok(w.sweepTxHash);
      assert.deepEqual(statusTrail(fx.deps, v.id), ["approved", "onchain_pending", "onchain_settled", "completed"]);
      assert.equal(fx.fast.calls.sendToWallet, 1);
      assert.equal(counting.calls.createPayout, 0);
      assert.deepEqual(await balance(fx), { available: "15.00", held: "0.00" });
      assertReconciledThroughout(fx);
    });

    test("no XSGD trust line → failed with a reason the merchant can act on; hold released", async () => {
      const fx = await withdrawalFixture({ balance: "20", bank: false });
      fx.fast.noTrustLine.add(WALLET);
      const v = await requested(fx, "5", { kind: "xrpl_wallet", address: WALLET });
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      const w = await waitForStatus(fx.deps, v.id, ["failed", "completed"]);
      assert.equal(w.failureReason, NO_TRUST_LINE_REASON);
      assert.deepEqual(await balance(fx), { available: "20.00", held: "0.00" });
    });

    test("the real engine's XrplDestinationError message is passed on", async () => {
      const fx = await withdrawalFixture({ balance: "20", bank: false });
      fx.fast.engine.sendToWallet = async () => {
        throw Object.assign(new Error("The wallet rP4xQn…Y9Kd isn't activated on the XRPL testnet yet."), { name: "XrplDestinationError" });
      };
      const v = await requested(fx, "5", { kind: "xrpl_wallet", address: WALLET });
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      const w = await waitForStatus(fx.deps, v.id, ["failed", "completed"]);
      assert.equal(w.failureReason, "The wallet rP4xQn…Y9Kd isn't activated on the XRPL testnet yet. Nothing left your balance.");
    });
  });

  describe("partner callbacks", () => {
    test("duplicates and strangers are ignored", async () => {
      const silent = createSilentPartner();
      const fx = await withdrawalFixture({ balance: "50", payouts: silent.partner });
      const v = await requested(fx, "10");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      const w = await waitForStatus(fx.deps, v.id, ["payout_pending"]);
      await idle(v.id);

      await handlePartnerUpdate(fx.deps, { partnerPayoutId: "po_other", withdrawalId: v.id, status: "completed", reference: "FAST-000000" });
      await handlePartnerUpdate(fx.deps, { partnerPayoutId: "po_x", withdrawalId: "wd_unknown", status: "completed" });
      assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "payout_pending");

      const ok = { partnerPayoutId: w.partnerPayoutId!, withdrawalId: v.id, status: "completed" as const, reference: "FAST-123456" };
      await Promise.all([handlePartnerUpdate(fx.deps, ok), handlePartnerUpdate(fx.deps, ok)]);
      await handlePartnerUpdate(fx.deps, { ...ok, status: "failed" });
      const done = await fx.deps.db.getWithdrawal(v.id);
      assert.equal(done?.status, "completed");
      assert.equal(done?.bankRef, "FAST-123456");
      assert.deepEqual(statusTrail(fx.deps, v.id), BANK_PATH);
      assert.equal(fx.fast.calls.settle, 0, "a late 'failed' after completion returns nothing");
    });
  });

  describe("resume on boot", () => {
    test("approved → continues from the on-chain step to completed", async () => {
      const fx = await withdrawalFixture({ balance: "70" });
      const stop = startPartnerCallbacks(fx.deps);
      try {
        const v = await requested(fx, "70");
        const r = await fx.deps.db.approveWithdrawal(v.id, "act_1"); // the process died right after approving
        assert.ok(r.ok);
        await resumeWithdrawals(fx.deps);
        await waitForStatus(fx.deps, v.id, ["completed"]);
        await idle(v.id);
        assert.deepEqual(statusTrail(fx.deps, v.id), ["onchain_pending", "onchain_settled", "payout_pending", "completed"]);
        assert.deepEqual(await balance(fx), { available: "0.00", held: "0.00" });
        assert.ok((await fx.reconciled()).ok);
      } finally {
        stop();
      }
    });

    test("payout_pending → asks the partner (completed → completed + bank ref)", async () => {
      const silent = createSilentPartner();
      const fx = await withdrawalFixture({ balance: "70", payouts: silent.partner });
      const v = await requested(fx, "20");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      await waitForStatus(fx.deps, v.id, ["payout_pending"]);
      await idle(v.id);

      await resumeWithdrawals(fx.deps); // still pending at the partner: nothing changes
      assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "payout_pending");

      silent.decide(v.id, { status: "completed", reference: "FAST-424242" });
      await resumeWithdrawals(fx.deps);
      const w = await fx.deps.db.getWithdrawal(v.id);
      assert.equal(w?.status, "completed");
      assert.equal(w?.bankRef, "FAST-424242");
      assert.equal(silent.calls.createPayout, 1);
      assert.deepEqual(await balance(fx), { available: "50.00", held: "0.00" });
    });

    test("payout_pending → partner says failed → returned and re-credited", async () => {
      const silent = createSilentPartner();
      const fx = await withdrawalFixture({ balance: "70", payouts: silent.partner });
      const v = await requested(fx, "20");
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" });
      await waitForStatus(fx.deps, v.id, ["payout_pending"]);
      await idle(v.id);
      silent.decide(v.id, { status: "failed", failureReason: "Account closed" });
      await resumeWithdrawals(fx.deps);
      assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "returned");
      assert.deepEqual(await balance(fx), { available: "70.00", held: "0.00" });
      assert.ok((await fx.reconciled()).ok);
    });

    test("onchain_pending without a tx hash → logged for manual review, never re-sent", async () => {
      const fx = await withdrawalFixture({ balance: "70" });
      const v = await requested(fx, "20");
      await fx.deps.db.approveWithdrawal(v.id, "act_1");
      await fx.deps.db.transitionWithdrawal(v.id, ["approved"], "onchain_pending"); // died mid-transfer

      await resumeWithdrawals(fx.deps);
      await executeWithdrawal(fx.deps, v.id, { actionId: "act_1" }); // a retried /execute doesn't send either
      await idle(v.id);
      assert.equal(fx.fast.calls.sweepToRedemption, 0);
      assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "onchain_pending");
      assert.deepEqual(await balance(fx), { available: "50.00", held: "20.00" }, "still held: the money is accounted for");
      const flagged = fx.logs.filter((l) => l.level === "error" && l.line.includes("MANUAL REVIEW") && l.line.includes(v.id));
      assert.equal(flagged.length, 2);
    });

    test("onchain_pending with a tx hash → recorded as settled (+ debit), then paid out", async () => {
      const fx = await withdrawalFixture({ balance: "70" });
      const stop = startPartnerCallbacks(fx.deps);
      try {
        const v = await requested(fx, "20");
        await fx.deps.db.approveWithdrawal(v.id, "act_1");
        await fx.deps.db.transitionWithdrawal(v.id, ["approved"], "onchain_pending", { sweepTxHash: "TXKNOWN" });
        fx.fast.debit(fx.address, money("20", "SGD")); // the transfer did happen
        await resumeWithdrawals(fx.deps);
        const w = await waitForStatus(fx.deps, v.id, ["completed"]);
        assert.equal(w.sweepTxHash, "TXKNOWN");
        assert.equal(fx.fast.calls.sweepToRedemption, 0);
        assert.deepEqual(await balance(fx), { available: "50.00", held: "0.00" });
        assert.ok((await fx.reconciled()).ok);
      } finally {
        stop();
      }
    });

    test("onchain_settled bank withdrawal without a payout → books the debit if missing, creates the payout", async () => {
      const counting = createCountingPartner();
      const fx = await withdrawalFixture({ balance: "70", payouts: counting.partner });
      const stop = startPartnerCallbacks(fx.deps);
      try {
        const v = await requested(fx, "20");
        await fx.deps.db.approveWithdrawal(v.id, "act_1");
        await fx.deps.db.transitionWithdrawal(v.id, ["approved"], "onchain_pending");
        // Died between the onchain_settled CAS and the withdrawal_debit append.
        await fx.deps.db.transitionWithdrawal(v.id, ["onchain_pending"], "onchain_settled", { sweepTxHash: "TXSWEPT" });
        fx.fast.debit(fx.address, money("20", "SGD"));
        assert.equal((await fx.reconciled()).ok, false, "precondition: the debit is missing");

        await resumeWithdrawals(fx.deps);
        await waitForStatus(fx.deps, v.id, ["completed"]);
        await idle(v.id);
        assert.equal(counting.calls.createPayout, 1);
        assert.deepEqual(statusTrail(fx.deps, v.id), ["payout_pending", "completed"]);
        assert.deepEqual(await balance(fx), { available: "50.00", held: "0.00" });
        assert.ok((await fx.reconciled()).ok);
      } finally {
        stop();
      }
    });

    test("onchain_settled wallet withdrawal → completed", async () => {
      const fx = await withdrawalFixture({ balance: "70", bank: false });
      const v = await requested(fx, "20", { kind: "xrpl_wallet", address: WALLET });
      await fx.deps.db.approveWithdrawal(v.id, "act_1");
      await fx.deps.db.transitionWithdrawal(v.id, ["approved"], "onchain_pending");
      await fx.deps.db.transitionWithdrawal(v.id, ["onchain_pending"], "onchain_settled", { sweepTxHash: "TXW" });
      fx.fast.debit(fx.address, money("20", "SGD"));
      await resumeWithdrawals(fx.deps);
      assert.equal((await fx.deps.db.getWithdrawal(v.id))?.status, "completed");
      assert.ok((await fx.reconciled()).ok);
    });
  });

  test("POST /internal/withdrawals/:id/execute → 202, then completes; unknown id → 404", async () => {
    const fx = await withdrawalFixture({ balance: "30" });
    const stop = startPartnerCallbacks(fx.deps);
    try {
      const app = createServer(fx.deps);
      const headers = { authorization: `Bearer ${TEST_INTERNAL_SECRET}`, "content-type": "application/json" };
      const v = await requested(fx, "30");
      const res = await app.request(`/internal/withdrawals/${v.id}/execute`, { method: "POST", headers, body: JSON.stringify({ actionId: "act_1" }) });
      assert.equal(res.status, 202);
      await waitForStatus(fx.deps, v.id, ["completed"]);
      await idle(v.id);

      const missing = await app.request("/internal/withdrawals/wd_nope/execute", { method: "POST", headers, body: JSON.stringify({ actionId: "act_1" }) });
      assert.equal(missing.status, 404);
      assert.equal(((await missing.json()) as { error: string }).error, "withdrawal_not_found");
    } finally {
      stop();
    }
  });
});
