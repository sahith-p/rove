// BNB lane end to end on createTestDeps (PGlite + test engine): deposit seen → 3 confirmations → authorized →
// settle (the settle poller, or scheduleSettle straight from the watcher) → settled + ledger payment_credit + event.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoveEvent } from "@rove/shared";
import type { WorkerDeps } from "../deps";
import { pollSettlements } from "../settle";
import { createKit, liveMerchant, NO_TEST_DB, testDbAvailable } from "../settle/testkit";
import { startBnbWatcher } from "./index";
import { bnbPayment, FakeChain, keyring, TEST_MNEMONIC, TEST_TOKEN, units, WATCH_OPTS } from "./testkit";
import { createBnbWatcher } from "./watcher";

const skip = (await testDbAvailable()) ? false : NO_TEST_DB;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusOf = async (deps: WorkerDeps, id: string) => (await deps.db.getPayment(id))?.status;
const settledEvents = (events: RoveEvent[]) => events.filter((e): e is Extract<RoveEvent, { type: "payment.settled" }> => e.type === "payment.settled");

const ENV = {
  BSC_TOKEN_ADDRESS: TEST_TOKEN,
  BSC_TOKEN_DECIMALS: "18",
  BSC_DEPOSIT_MNEMONIC: TEST_MNEMONIC,
  BSC_DEPOSIT_XPUB: keyring.xpub,
  BSC_POLL_MS: "20",
  BSC_RESCAN_BLOCKS: "500",
};

describe("BNB lane end to end", { skip }, () => {
  test("deposit → authorized → settle poller → settled, XSGD credited in the ledger, from the USD float", async (t) => {
    const { deps, engine } = await createKit(t);
    await liveMerchant(deps);
    const chain = new FakeChain();
    const watcher = createBnbWatcher(deps, chain, { ...WATCH_OPTS, settle: "poller" });
    const { payment, address } = await bnbPayment(deps); // S$12.50, US$9.69

    chain.transfer(address, units("9.69"));
    chain.mine(3);
    await watcher.poll();
    assert.equal(await statusOf(deps, payment.id), "authorized");

    await pollSettlements(deps); // the settle poller's pass
    const p = await deps.db.getPayment(payment.id);
    assert.equal(p?.status, "settled");
    assert.equal(p?.method, "bnb");
    assert.equal(p?.deliveredAmount, "12.50");
    assert.equal(engine.calls.settle.length, 1);
    assert.equal(engine.calls.settle[0]!.from, "USD", "USDT pay-ins settle from the RLUSD float");
    assert.equal(engine.calls.settle[0]!.local.amount, "12.50");
    assert.equal(engine.calls.settle[0]!.merchantAddress, "rTESTAHSENG");
    assert.equal((await deps.db.getBalance("ahseng")).available.amount, "12.50");
    const [settled] = settledEvents(deps.events);
    assert.equal(settled?.paymentId, payment.id);
    assert.equal(settled?.firstSale, true);
    assert.equal(settled?.local.amount, "12.50");
  });

  test("startBnbWatcher: polls on its own, authorizes, schedules the settlement straight away; stopper stops it", async (t) => {
    const { deps, logs } = await createKit(t);
    await liveMerchant(deps);
    const chain = new FakeChain();
    const { payment, address } = await bnbPayment(deps);
    const stop = startBnbWatcher(deps, { env: ENV, source: chain });
    t.after(stop);

    chain.transfer(address, units("9.69"));
    chain.mine(3);
    await waitFor(async () => (await statusOf(deps, payment.id)) === "settled");
    assert.equal((await deps.db.getBalance("ahseng")).available.amount, "12.50");
    assert.equal(settledEvents(deps.events).length, 1);
    assert.ok(logs.some((l) => /BNB watcher started/.test(l) && l.includes('"symbol":"tUSDT"')));
    assert.ok(!logs.some((l) => /doesn't match BSC_DEPOSIT_MNEMONIC/.test(l)));

    stop();
    const calls = chain.calls.transfers.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(chain.calls.transfers.length, calls, "no polls after stop");
  });

  test("startBnbWatcher refuses the wrong chain, or a token whose decimals don't match the config", async (t) => {
    const { deps, logs } = await createKit(t);
    const mainnet = Object.assign(new FakeChain(), { id: 56 });
    startBnbWatcher(deps, { env: ENV, source: mainnet })();
    await waitFor(async () => logs.some((l) => /not BSC testnet \(97\)/.test(l)));
    assert.equal(mainnet.calls.transfers.length, 0);

    const sixDecimals = new FakeChain();
    sixDecimals.token = { symbol: "USDT", decimals: 6 };
    const stop = startBnbWatcher(deps, { env: ENV, source: sixDecimals });
    t.after(stop);
    await waitFor(async () => logs.some((l) => /BSC_TOKEN_DECIMALS=18 but USDT .* has 6 decimals: amounts would be off by 10\^12/.test(l)));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sixDecimals.calls.transfers.length, 0);
  });

  test("startBnbWatcher: off without a token; flags an xpub that doesn't match the mnemonic; keeps polling through RPC errors", async (t) => {
    const { deps, logs } = await createKit(t);
    const off = new FakeChain();
    startBnbWatcher(deps, { env: {}, source: off })();
    assert.ok(logs.some((l) => /BNB watcher off/.test(l)));

    const other = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const flaky = new FakeChain();
    flaky.failTransfers = 2;
    const stop = startBnbWatcher(deps, { env: { ...ENV, BSC_DEPOSIT_MNEMONIC: other }, source: flaky });
    t.after(stop);
    assert.ok(logs.some((l) => /BSC_DEPOSIT_XPUB doesn't match BSC_DEPOSIT_MNEMONIC/.test(l)));
    await waitFor(async () => logs.some((l) => /BSC RPC reachable again/.test(l)));
    assert.equal(logs.filter((l) => /BNB watcher poll failed/.test(l)).length, 1, "an outage is logged once, not every 3 s");
  });
});
