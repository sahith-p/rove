// NI-C3 · createWithdrawal: limits, fee, destination, step-up (withdrawals.md §3a). Real SQL via createTestDeps().

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { WithdrawalViewZ } from "@rove/shared";
import { isUserFacingError } from "../errors";
import { TEST_INTERNAL_SECRET } from "../testing";
import { createServer } from "../server";
import { createWithdrawal, NO_BANK_ACCOUNT_MESSAGE } from "./create";
import { executeWithdrawal } from "./execute";
import { startPartnerCallbacks } from "./partner";
import { addMerchant, closeFixtures, dbSkipReason, waitForStatus, withdrawalFixture, type WithdrawalFixture } from "./testkit";

const skip = await dbSkipReason();
const WALLET = "rP4xQnF1mGkS8TzQvB2cWdK7Y9Kd";
const HOUR = 3600 * 1000;

/** Rejects with a UserFacingError carrying `code` (and `message`, when given). */
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

/** Runs one withdrawal all the way to completed (so the merchant is no longer a first-timer). */
async function completeOne(fx: WithdrawalFixture, amount: string) {
  const stop = startPartnerCallbacks(fx.deps);
  try {
    const v = await create(fx, amount);
    await executeWithdrawal(fx.deps, v.id, { actionId: `act_${v.id}` });
    await waitForStatus(fx.deps, v.id, ["completed"]);
  } finally {
    stop();
  }
}

describe("createWithdrawal (NI-C3)", { skip }, () => {
  after(closeFixtures);

  test("requested, fee S$0.00 shown, bank label, no money moves", async () => {
    const fx = await withdrawalFixture({ balance: "118.40" });
    const view = await create(fx, "50");
    WithdrawalViewZ.parse(view);
    assert.equal(view.status, "requested");
    assert.deepEqual(view.amount, { amount: "50.00", currency: "SGD" });
    assert.deepEqual(view.fee, { amount: "0.00", currency: "SGD" });
    assert.deepEqual(view.destination, { kind: "bank", label: "DBS ••••1234" });
    assert.equal(view.needsStepUp, true, "first withdrawal");

    const bal = await fx.deps.db.getBalance(fx.merchantId);
    assert.equal(bal.available.amount, "118.40", "nothing held until a human confirms");
    assert.equal(bal.held.amount, "0.00");
    assert.equal(fx.fast.calls.sweepToRedemption, 0);
    assert.equal(fx.deps.events.length, 0);
    const row = await fx.deps.db.getWithdrawal(view.id);
    assert.deepEqual(row?.destination.kind, "bank");
  });

  test("amount null = everything available", async () => {
    const fx = await withdrawalFixture({ balance: "118.40" });
    await fx.seed("6.50");
    const view = await create(fx, null);
    assert.equal(view.amount.amount, "124.90");
  });

  test("minimum S$1.00", async () => {
    const fx = await withdrawalFixture({ balance: "20" });
    await refuses(create(fx, "0.99"), "below_minimum", "The minimum withdrawal is S$1.00.");
    await refuses(create(fx, "0"), "below_minimum");
    assert.equal((await create(fx, "1")).amount.amount, "1.00");

    const small = await withdrawalFixture({ balance: "0.40" });
    await refuses(create(small, null), "below_minimum", "You have S$0.40 available; the minimum withdrawal is S$1.00.");
  });

  test("not more than available: says the available amount", async () => {
    const fx = await withdrawalFixture({ balance: "42.10" });
    await refuses(create(fx, "42.11"), "insufficient_funds", "You have S$42.10 available to withdraw.");
    const empty = await withdrawalFixture();
    await refuses(create(empty, null), "nothing_to_withdraw", "You have S$0.00 available to withdraw right now.");
    await refuses(create(empty, "5"), "insufficient_funds", "You have S$0.00 available to withdraw.");
  });

  test("daily max S$2,000 counts today's requested and in-flight withdrawals", async () => {
    const fx = await withdrawalFixture({ balance: "2500" });
    await create(fx, "1500");
    await refuses(create(fx, "600"), "daily_limit", "You can withdraw up to S$2000.00 a day, and you have S$500.00 left today.");
    await create(fx, "500");
    await refuses(create(fx, "1"), "daily_limit", "You've reached today's S$2000.00 withdrawal limit. Try again tomorrow.");
    await refuses(create(fx, null), "daily_limit");
  });

  test("cents only", async () => {
    const fx = await withdrawalFixture({ balance: "20" });
    await refuses(create(fx, "1.005"), "invalid_amount", "Amounts go to the cent, like 12.50.");
  });

  test("no bank account → no_bank_account with the agent's line", async () => {
    const fx = await withdrawalFixture({ balance: "20", bank: false });
    await refuses(create(fx, "10"), "no_bank_account", NO_BANK_ACCOUNT_MESSAGE);
    assert.equal(NO_BANK_ACCOUNT_MESSAGE, "Add your bank first: say 'add my bank'.");
  });

  test("an explicit bank account must belong to the merchant", async () => {
    const a = await withdrawalFixture({ balance: "20" });
    const b = await addMerchant(a.deps, a.fast);
    const bBankId = await b.addBank();
    await refuses(create(a, "10", { kind: "bank", bankAccountId: bBankId }), "bank_account_not_found");
    await refuses(create(a, "10", { kind: "bank", bankAccountId: "bank_nope" }), "bank_account_not_found");
    const aBank = (await a.deps.db.getDefaultBankAccount(a.merchantId))!;
    assert.equal((await create(a, "10", { kind: "bank", bankAccountId: aBank.id })).destination.label, "DBS ••••1234");
  });

  test("PayNow proxies are labelled PayNow", async () => {
    const fx = await withdrawalFixture({ balance: "20", bank: false });
    await fx.addBank({ bankName: null });
    assert.equal((await create(fx, "10")).destination.label, "PayNow ••••1234");
  });

  test("wallet destination: valid address, not the custodial account itself", async () => {
    const fx = await withdrawalFixture({ balance: "20", bank: false });
    const view = await create(fx, "5", { kind: "xrpl_wallet", address: WALLET });
    assert.deepEqual(view.destination, { kind: "xrpl_wallet", label: "rP4x…9Kd" });
    await refuses(create(fx, "5", { kind: "xrpl_wallet", address: "rNOPE0OIl" }), "invalid_wallet");
    await refuses(create(fx, "5", { kind: "xrpl_wallet", address: fx.address }), "invalid_wallet");
  });

  describe("wallet pre-check (engines with checkWalletDestination, i.e. the real one)", () => {
    class XrplDestinationError extends Error {
      override name = "XrplDestinationError";
      constructor(
        message: string,
        readonly reason: string,
      ) {
        super(message);
      }
    }
    const withCheck = async (check: (input: { address: string; local: { amount: string } }) => Promise<unknown>) => {
      const fx = await withdrawalFixture({ balance: "20", bank: false });
      Object.assign(fx.fast.engine, { checkWalletDestination: check });
      return fx;
    };

    test("a returned XrplDestinationError refuses with its message; no withdrawal row", async () => {
      const seen: unknown[] = [];
      const fx = await withCheck(async (input) => {
        seen.push(input);
        return new XrplDestinationError("The wallet rP4xQn…Y9Kd can't receive XSGD yet: it needs an XSGD trust line.", "no_trust_line");
      });
      await refuses(create(fx, "5", { kind: "xrpl_wallet", address: WALLET }), "wallet_cannot_receive", /needs an XSGD trust line/);
      assert.deepEqual(seen, [{ address: WALLET, local: { amount: "5.00", currency: "SGD" }, merchantAddress: fx.address }]);
      assert.deepEqual(await fx.deps.db.listWithdrawals(fx.merchantId), []);
    });

    test("a thrown XrplDestinationError refuses too", async () => {
      const fx = await withCheck(async () => {
        throw new XrplDestinationError("The wallet isn't activated on the XRPL testnet yet.", "no_account");
      });
      await refuses(create(fx, "5", { kind: "xrpl_wallet", address: WALLET }), "wallet_cannot_receive", "The wallet isn't activated on the XRPL testnet yet.");
    });

    test("null → ok; a network error → ok (sendToWallet checks again at execute time)", async () => {
      const ok = await withCheck(async () => null);
      assert.equal((await create(ok, "5", { kind: "xrpl_wallet", address: WALLET })).status, "requested");
      const down = await withCheck(async () => {
        throw new Error("websocket closed");
      });
      assert.equal((await create(down, "5", { kind: "xrpl_wallet", address: WALLET })).status, "requested");
      assert.ok(down.logs.some((l) => l.level === "warn" && l.line.includes("wallet pre-check failed")));
    });
  });

  test("shop must be live", async () => {
    const fx = await withdrawalFixture({ balance: "20" });
    await fx.deps.db.upsertDraftMerchant({ id: "drafty", name: "Drafty", phone: "+15550009999", channel: "imessage" });
    await refuses(createWithdrawal(fx.deps, { merchantId: "drafty", amount: "5", destination: null }), "merchant_not_live");
    await refuses(createWithdrawal(fx.deps, { merchantId: "nobody", amount: "5", destination: null }), "merchant_not_found");
  });

  describe("step-up", () => {
    test("first withdrawal → step-up, even small and with an old bank account", async () => {
      const fx = await withdrawalFixture({ balance: "50" });
      const later = { ...fx.deps, now: () => new Date(Date.now() + 25 * HOUR) };
      assert.equal((await createWithdrawal(later, { merchantId: fx.merchantId, amount: "5", destination: null })).needsStepUp, true);
    });

    test("after a completed withdrawal: old bank + ≤ S$200 → no step-up; > S$200 or a new bank → step-up", async () => {
      const fx = await withdrawalFixture({ balance: "600" });
      await completeOne(fx, "10");
      const later = { ...fx.deps, now: () => new Date(Date.now() + 25 * HOUR) };
      const make = (deps: typeof fx.deps, amount: string) => createWithdrawal(deps, { merchantId: fx.merchantId, amount, destination: null });

      assert.equal((await make(later, "200")).needsStepUp, false, "S$200.00 is not above S$200");
      assert.equal((await make(later, "200.01")).needsStepUp, true, "above S$200");
      assert.equal((await make(fx.deps, "5")).needsStepUp, true, "bank account added < 24h ago");
    });

    test("wallet withdrawals skip the bank-age rule", async () => {
      const fx = await withdrawalFixture({ balance: "100" });
      await completeOne(fx, "10");
      const view = await create(fx, "5", { kind: "xrpl_wallet", address: WALLET });
      assert.equal(view.needsStepUp, false);
    });
  });

  test("POST /internal/withdrawals: 200 view, 422 with the message to say", async () => {
    const fx = await withdrawalFixture({ balance: "42.10" });
    const app = createServer(fx.deps);
    const headers = { authorization: `Bearer ${TEST_INTERNAL_SECRET}`, "content-type": "application/json" };
    const ok = await app.request("/internal/withdrawals", { method: "POST", headers, body: JSON.stringify({ merchantId: fx.merchantId, amount: null, destination: null }) });
    assert.equal(ok.status, 200);
    assert.equal(WithdrawalViewZ.parse(await ok.json()).amount.amount, "42.10");

    const over = await app.request("/internal/withdrawals", { method: "POST", headers, body: JSON.stringify({ merchantId: fx.merchantId, amount: "50", destination: null }) });
    assert.equal(over.status, 422);
    assert.deepEqual(await over.json(), { error: "insufficient_funds", message: "You have S$42.10 available to withdraw." });
  });
});
