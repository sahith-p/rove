// Corridors Phase B: withdrawals per currency (docs/specs/corridors.md §7). Limits, fee and messages in the shop's
// currency; bank payouts through the currency's partner (EUR → the simulated SEPA partner); USD shops wallet-only.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { money } from "@rove/shared";
import { isUserFacingError } from "../errors";
import { createWithdrawal } from "./create";
import { executeWithdrawal } from "./execute";
import { startPartnerCallbacks } from "./partner";
import { closeFixtures, dbSkipReason, statusTrail, waitForStatus, withdrawalFixture, type WithdrawalFixture } from "./testkit";

const skip = await dbSkipReason();
const WALLET = "rP4xQnF1mGkS8TzQvB2cWdK7Y9Kd";

async function refuses(p: Promise<unknown>, code: string, message?: string | RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(isUserFacingError(err), `expected a UserFacingError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (typeof message === "string") assert.equal(err.message, message);
    else if (message) assert.match(err.message, message);
    return true;
  });
}

const create = (fx: WithdrawalFixture, amount: string | null, destination: Parameters<typeof createWithdrawal>[1]["destination"] = null) =>
  createWithdrawal(fx.deps, { merchantId: fx.merchantId, amount, destination });

describe("withdrawals per currency (corridors)", { skip }, () => {
  after(closeFixtures);

  test("EUR shop: limits, fee and messages in euros (€1 min, €150 step-up, €1,500 a day)", async () => {
    const fx = await withdrawalFixture({ currency: "EUR", balance: "2000.00" });
    await refuses(create(fx, "0.99"), "below_minimum", "The minimum withdrawal is €1.00.");
    await refuses(create(fx, "1500.01"), "daily_limit", /€1500\.00 a day/);
    await refuses(create(fx, "2000.01"), "insufficient_funds", "You have €2000.00 available to withdraw.");

    const view = await create(fx, "150.01");
    assert.deepEqual([view.amount, view.fee], [money("150.01", "EUR"), money("0.00", "EUR")]);
    assert.deepEqual(view.destination, { kind: "bank", label: "IBAN ••••3000" });
    assert.equal(view.needsStepUp, true);
  });

  test("EUR shop: bank withdrawal sweeps EUR and pays out over the simulated SEPA partner (SCTINST ref)", async () => {
    const fx = await withdrawalFixture({ currency: "EUR", balance: "40.00" });
    const view = await create(fx, "25");
    const stop = startPartnerCallbacks(fx.deps);
    try {
      await executeWithdrawal(fx.deps, view.id, { actionId: `act_${view.id}` });
      const w = await waitForStatus(fx.deps, view.id, ["completed", "failed", "returned"]);
      assert.equal(w.status, "completed", w.failureReason);
      assert.match(w.bankRef ?? "", /^SCTINST-\d{6}$/);
      assert.match(w.partnerPayoutId ?? "", /^sepa_po_/);
    } finally {
      stop();
    }
    assert.deepEqual(statusTrail(fx.deps, view.id), ["approved", "onchain_pending", "onchain_settled", "payout_pending", "completed"]);
    assert.equal(fx.fast.calls.sweepToRedemption, 1);
    const snap = await fx.reconciled();
    assert.deepEqual([snap.available, snap.held, snap.onchain, snap.ok], ["15.00", "0.00", "15.00", true]);
    const bal = await fx.deps.db.getBalance(fx.merchantId);
    assert.equal(bal.available.currency, "EUR");
  });

  test("a bank account that can't receive the shop's currency is refused", async () => {
    const fx = await withdrawalFixture({ balance: "50.00" }); // SGD shop with a DBS account …
    await fx.deps.db.updateShop(fx.merchantId, { currency: "EUR" }); // … that now takes EUR
    await refuses(create(fx, "10"), "bank_account_wrong_currency", "That bank account can't receive EUR. Say 'add my bank' to add your IBAN.");
  });

  test("USD shop: no bank payout partner yet → wallet withdrawals only", async () => {
    const fx = await withdrawalFixture({ currency: "USD", bank: false, balance: "30.00" });
    await refuses(create(fx, "10"), "no_bank_payout", /Bank withdrawals in USD aren't available yet.*XRPL wallet/);
    const view = await create(fx, "10", { kind: "xrpl_wallet", address: WALLET });
    assert.deepEqual([view.amount, view.destination.kind], [money("10.00", "USD"), "xrpl_wallet"]);
  });

  test("SGD shops keep the original limits (S$1 / S$200 / S$2,000)", async () => {
    const fx = await withdrawalFixture({ balance: "2500.00" });
    await refuses(create(fx, "2000.01"), "daily_limit", /S\$2000\.00 a day/);
    assert.equal((await create(fx, "200.00")).needsStepUp, true, "first withdrawal");
  });
});
