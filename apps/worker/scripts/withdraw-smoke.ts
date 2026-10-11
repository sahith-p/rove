// Gate G4 seam test (docs/06-testing.md §2): one bank withdrawal through the real pipeline code.
//
//   pnpm --filter worker exec tsx scripts/withdraw-smoke.ts [merchantId=ahseng] [amount=10]
//
// Runs createWithdrawal → executeWithdrawal → partner callback in-process with the MOCK engine and the MOCK payout
// partner (simulated StraitsX, ~2s callback), on a throwaway PGlite database, or on DATABASE_URL when that is set in
// the environment (the repo .env is deliberately not loaded). It sets up what's missing (live merchant, default bank,
// a balance big enough), mirrors the ledger into the mock chain, prints every withdrawal.updated until the withdrawal
// finishes, then prints ledger available/held next to the engine balance and asserts they agree.
// MOCK_PAYOUT_FAIL=1 exercises the bounce: the withdrawal ends `returned` and the money is back (exit code 1).
//
// With DATABASE_URL the mock engine writes simulated ledger rows to that database, which would put a merchant whose
// account is real (not rMOCK…) out of step with XRPL; that needs --force.

import assert from "node:assert/strict";
import { createDb, type Db } from "@rove/db";
import { add, cmp, format, isPositive, money, newId, sub, toMinor, type RoveEvent, type WithdrawalStatus } from "@rove/shared";
import { createMockPayoutPartner, createMockSettlement, DEMO_MERCHANT } from "@rove/shared/mocks";
import type { WorkerDeps } from "../src/deps";
import type { Emit } from "../src/emit";
import { createLogger, type LogLevel } from "../src/log";
import { TEST_CONFIG } from "../src/testing";
import { createWithdrawal } from "../src/withdrawals/create";
import { executeWithdrawal } from "../src/withdrawals/execute";
import { idle } from "../src/withdrawals/lock";
import { startPartnerCallbacks } from "../src/withdrawals/partner";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [merchantId = "ahseng", amountArg = "10"] = args.filter((a) => !a.startsWith("--"));
const FINAL: WithdrawalStatus[] = ["completed", "failed", "returned", "cancelled"];
const BANK_PATH: WithdrawalStatus[] = ["approved", "onchain_pending", "onchain_settled", "payout_pending", "completed"];
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);

async function openDb(): Promise<{ db: Db; label: string }> {
  if (process.env.DATABASE_URL) return { db: createDb(), label: "DATABASE_URL" };
  const { createTestDb } = await import("@rove/db/testing");
  return { db: await createTestDb(), label: "throwaway PGlite" };
}

async function main(): Promise<number> {
  money(amountArg, "SGD"); // fail fast on a malformed amount; re-read below in the merchant's currency
  const { db, label } = await openDb();
  const settlement = createMockSettlement();
  const payouts = createMockPayoutPartner();
  const trail: WithdrawalStatus[] = [];

  const emit: Emit = Object.assign(
    async (event: RoveEvent) => {
      if (event.type !== "withdrawal.updated") return;
      trail.push(event.status);
      const extra = [
        event.sweepTxHash && `tx ${event.sweepTxHash.slice(0, 12)}…`,
        event.bankRef && `bank ref ${event.bankRef}`,
        event.failureReason && `"${event.failureReason}"`,
      ].filter(Boolean);
      console.log(`${at()}  ${event.status.padEnd(16)} ${format(event.amount)}${extra.length ? "  " + extra.join("  ") : ""}`);
    },
    { deliver: async () => true },
  );
  const deps: WorkerDeps = {
    db,
    settlement,
    payouts,
    stripe: null,
    emit,
    config: TEST_CONFIG,
    log: createLogger("smoke", { level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "warn" }),
    now: () => new Date(),
  };

  try {
    console.log(`withdraw-smoke · ${merchantId} · ${amountArg} · db: ${label} · engine: mock · payouts: mock (simulated StraitsX)`);

    // 1. a live merchant with a (mock) custodial account
    let merchant = await db.getMerchant(merchantId);
    if (process.env.DATABASE_URL && merchant?.xrplAddress && !merchant.xrplAddress.startsWith("rMOCK") && !force) {
      throw new Error(
        `${merchantId} has a real XRPL account (${merchant.xrplAddress}); a mock-engine run would write simulated ledger rows ` +
          `and put its ledger out of step with XRPL. Use a throwaway merchant id, unset DATABASE_URL, or pass --force.`,
      );
    }
    if (!merchant) {
      const demo = merchantId === DEMO_MERCHANT.id;
      merchant = await db.upsertDraftMerchant({
        id: merchantId,
        name: demo ? DEMO_MERCHANT.name : "Smoke Test Kopi",
        phone: demo ? DEMO_MERCHANT.phone : "+15555550142",
        channel: "imessage",
        category: demo ? DEMO_MERCHANT.category : "cafe",
      });
      console.log(`  created draft merchant ${merchantId}`);
    }
    if (!merchant.xrplAddress || merchant.status !== "live") {
      const acct = merchant.xrplAddress ? null : await settlement.createMerchantAccount({ merchantId, currency: merchant.currency });
      if (acct) await db.setMerchantXrpl(merchantId, { xrplAddress: acct.xrplAddress, xrplSeedEnc: "mock", credentialStatus: acct.credentialStatus });
      await db.setMerchantLive(merchantId);
      merchant = (await db.getMerchant(merchantId))!;
      console.log(`  merchant live with mock account ${merchant.xrplAddress}`);
    }
    const address = merchant.xrplAddress!;
    const currency = merchant.currency;
    const amount = money(amountArg, currency);

    // 2. a default bank account (simulated beneficiary; no real numbers anywhere)
    if (!(await db.getDefaultBankAccount(merchantId))) {
      const b = await payouts.createBeneficiary({ merchantId, type: "paynow_uen", proxy: "201912345K", holderName: merchant.name });
      await db.insertBankAccount({ merchantId, type: "paynow_uen", bankName: null, last4: b.last4, holderName: b.resolvedName, beneficiaryId: b.beneficiaryId, status: b.status });
      console.log(`  added bank account PayNow ••••${b.last4} (${b.resolvedName})`);
    }

    // 3. the mock chain starts empty: mirror the ledger into it, then top up if the balance is short
    const ledger = await db.getBalance(merchantId);
    const total = add(ledger.available, ledger.held);
    if (isPositive(total)) {
      await settlement.settle({ paymentId: `smoke_mirror_${merchantId}`, merchantAddress: address, local: total, sendMaxUsd: "0", from: currency });
      console.log(`  mock chain now mirrors the ledger: ${format(total)}`);
    }
    if (cmp(ledger.available, amount) < 0) {
      const topUp = sub(amount, ledger.available);
      const paymentId = newId("pay");
      await settlement.settle({ paymentId, merchantAddress: address, local: topUp, sendMaxUsd: "0", from: currency });
      await db.appendLedger({ merchantId, kind: "payment_credit", amount: topUp, ref: paymentId });
      console.log(`  seeded ${format(topUp)} (simulated sale ${paymentId})`);
    }
    const before = await db.getBalance(merchantId);
    console.log(`  before: available ${format(before.available)} · held ${format(before.held)} · chain ${format(await settlement.balance({ merchantAddress: address, currency }))}`);

    // 4. propose (what the agent's propose_withdrawal does), then confirm (what the executor does after 👍)
    const view = await createWithdrawal(deps, { merchantId, amount: amount.amount, destination: null });
    console.log(
      `${at()}  ${view.status.padEnd(16)} ${format(view.amount)} → ${view.destination.label} · fee ${format(view.fee)} · step-up ${view.needsStepUp ? "yes" : "no"} · ${view.id}`,
    );
    trail.unshift("requested");
    const stop = startPartnerCallbacks(deps);
    let final: WithdrawalStatus;
    try {
      await executeWithdrawal(deps, view.id, { actionId: `smoke_${view.id}` });
      const until = Date.now() + 30_000;
      for (;;) {
        const w = await db.getWithdrawal(view.id);
        if (w && FINAL.includes(w.status)) {
          final = w.status;
          break;
        }
        if (Date.now() > until) throw new Error(`timed out at ${w?.status}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      await idle(view.id);
    } finally {
      stop();
    }

    // 5. ledger vs chain
    const after = await db.getBalance(merchantId);
    const chain = await settlement.balance({ merchantAddress: address, currency });
    const ledgerTotal = add(after.available, after.held);
    console.log(`  after:  available ${format(after.available)} · held ${format(after.held)} · chain ${format(chain)}`);
    assert.equal(toMinor(ledgerTotal), toMinor(chain), `ledger available + held (${format(ledgerTotal)}) != chain balance (${format(chain)})`);
    console.log(`  ✓ ledger available + held == chain balance (${format(chain)})`);

    if (final === "completed") {
      assert.deepEqual(trail, ["requested", ...BANK_PATH], `status trail ${trail.join(" → ")}`);
      assert.equal(after.available.amount, sub(before.available, amount).amount, "available dropped by the amount");
      assert.equal(after.held.amount, before.held.amount, "nothing left held");
      console.log(`  ✓ ${trail.join(" → ")}`);
      console.log(`  ✓ available −${format(amount)}, held unchanged (${format(after.held)})`);
      console.log("✓ G4 withdraw-smoke passed");
      return 0;
    }
    if (final === "returned") {
      assert.equal(after.available.amount, before.available.amount, "returned money is available again");
      console.log(`  ✓ returned: ${format(amount)} back in the balance`);
    }
    console.log(`✗ withdrawal ended ${final} (${trail.join(" → ")})`);
    return 1;
  } finally {
    await db.close().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
