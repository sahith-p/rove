import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { money, type PaymentStatus } from "@rove/shared";
import type { PaymentPatch } from "@rove/db";
import type { WorkerDeps } from "../deps";
import { authorizedPayment, createKit, liveMerchant, MAYA, NO_TEST_DB, testDbAvailable } from "../settle/testkit";
import { bnbPayment, FakeChain, units, WATCH_OPTS } from "./testkit";
import { claimKey, createBnbWatcher, expectedUnits, type DepositOutcome, type WatcherOptions } from "./watcher";

const skip = (await testDbAvailable()) ? false : NO_TEST_DB;

interface Transition {
  id: string;
  from: PaymentStatus[];
  to: PaymentStatus;
  patch: PaymentPatch | undefined;
}

/** Records every transitionPayment call (the Db interface doesn't read payin_tx_hash back). */
function spyTransitions(deps: WorkerDeps): Transition[] {
  const calls: Transition[] = [];
  const orig = deps.db.transitionPayment.bind(deps.db);
  deps.db.transitionPayment = async (id, from, to, patch) => {
    calls.push({ id, from, to, patch });
    return orig(id, from, to, patch);
  };
  return calls;
}

async function setup(t: TestContext, opts: Partial<WatcherOptions> = {}) {
  const kit = await createKit(t);
  await liveMerchant(kit.deps);
  const chain = new FakeChain();
  const transitions = spyTransitions(kit.deps);
  const watchOpts: WatcherOptions = { ...WATCH_OPTS, settle: "poller", ...opts };
  const watcher = createBnbWatcher(kit.deps, chain, watchOpts);
  return { ...kit, chain, transitions, watcher, watchOpts };
}

const statusOf = async (deps: WorkerDeps, id: string) => (await deps.db.getPayment(id))?.status;
const kinds = (outcomes: DepositOutcome[]) => outcomes.map((o) => o.kind);
const count = (logs: string[], re: RegExp) => logs.filter((l) => re.test(l)).length;

describe("BNB watcher", { skip }, () => {
  test("expectedUnits: the USD charge in 18-decimal base units, as a bigint", () => {
    assert.equal(expectedUnits({ charge: money("9.69", "USD"), quote: null }, 18), 9_690_000_000_000_000_000n);
    assert.equal(expectedUnits({ charge: money("0.01", "USD"), quote: null }, 6), 10_000n);
    assert.equal(expectedUnits({ charge: money("12.50", "SGD"), quote: null }, 18), null);
  });

  test("3-confirmation rule: seen at 1 and 2 confirmations (logged once), authorized at 3 with the tx hash", async (t) => {
    const { deps, chain, watcher, transitions, logs } = await setup(t);
    const { payment, address } = await bnbPayment(deps);
    const deposit = chain.transfer(address, units("9.69")); // block 10_001

    chain.mine(); // head 10_001: 1 confirmation
    let r = await watcher.poll();
    assert.deepEqual(kinds(r.outcomes), []);
    assert.equal(r.pending, 1);
    assert.equal(await statusOf(deps, payment.id), "created");
    assert.equal(r.cursor, 9_999n, "cursor stays below the unconfirmed block");

    chain.mine(); // 2 confirmations
    r = await watcher.poll();
    assert.deepEqual(kinds(r.outcomes), []);
    assert.equal(await statusOf(deps, payment.id), "created");
    assert.equal(count(logs, /deposit seen, waiting for confirmations/), 1);
    assert.ok(logs.some((l) => /deposit seen/.test(l) && l.includes('"confirmations":"1/3"')));

    chain.mine(); // 3 confirmations
    r = await watcher.poll();
    assert.deepEqual(r.outcomes, [{ kind: "authorized", paymentId: payment.id, late: false }]);
    const p = await deps.db.getPayment(payment.id);
    assert.equal(p?.status, "authorized");
    assert.equal(p?.method, "bnb");
    assert.deepEqual(transitions, [{ id: payment.id, from: ["created"], to: "authorized", patch: { method: "bnb", payinTxHash: deposit.txHash } }]);
    assert.ok(logs.some((l) => /deposit confirmed: payment authorized/.test(l) && l.includes(deposit.txHash) && l.includes("9.69 tUSDT")));
    assert.equal(r.cursor, 10_001n);
  });

  test("exact and over-payment authorize; 1 wei short is underpaid (logged loudly, left created)", async (t) => {
    const { deps, chain, watcher, logs } = await setup(t);
    const exact = await bnbPayment(deps);
    const over = await bnbPayment(deps);
    const under = await bnbPayment(deps);
    const due = units("9.69");
    assert.equal(due, 9_690_000_000_000_000_000n);
    chain.transfer(exact.address, due);
    chain.transfer(over.address, units("10.00"));
    chain.transfer(under.address, due - 1n);
    chain.mine(3);

    const r = await watcher.poll();
    assert.deepEqual(r.outcomes, [
      { kind: "authorized", paymentId: exact.payment.id, late: false },
      { kind: "authorized", paymentId: over.payment.id, late: false },
      { kind: "underpaid", paymentId: under.payment.id, expected: due, paid: due - 1n },
    ]);
    assert.equal(await statusOf(deps, exact.payment.id), "authorized");
    assert.equal(await statusOf(deps, over.payment.id), "authorized");
    assert.equal(await statusOf(deps, under.payment.id), "created");
    const line = logs.find((l) => /UNDERPAID/.test(l));
    assert.ok(line && line.includes("ERROR") && line.includes('"short":"0.000000000000000001 tUSDT"'), line);
  });

  test("claim dedupe across restarts: a new watcher rescans the window but acts on nothing twice", async (t) => {
    const { deps, chain, watcher, transitions, logs, watchOpts } = await setup(t);
    const paid = await bnbPayment(deps);
    const short = await bnbPayment(deps);
    const a = chain.transfer(paid.address, units("9.69"));
    const b = chain.transfer(short.address, units("1.00"));
    chain.mine(3);
    assert.deepEqual(kinds((await watcher.poll()).outcomes), ["authorized", "underpaid"]);
    const before = { transitions: transitions.length, confirmed: count(logs, /deposit confirmed/), underpaid: count(logs, /UNDERPAID/) };

    const restarted = createBnbWatcher(deps, chain, watchOpts); // fresh in-memory cursor
    const r = await restarted.poll();
    assert.deepEqual(r.outcomes, [
      { kind: "already_processed", paymentId: paid.payment.id },
      { kind: "already_processed", paymentId: short.payment.id },
    ]);
    assert.equal(transitions.length, before.transitions);
    assert.equal(count(logs, /deposit confirmed/), before.confirmed);
    assert.equal(count(logs, /UNDERPAID/), before.underpaid);
    assert.equal(count(logs, /EXTRA deposit/), 0);
    assert.equal(await deps.db.claim(claimKey(a)), false);
    assert.equal(await deps.db.claim(claimKey(b)), false);
    assert.equal(claimKey(a), `bsc:${a.txHash}:${a.logIndex}`);
  });

  test("a transfer to an address that isn't ours is ignored and never claimed", async (t) => {
    const { deps, chain, watcher, transitions } = await setup(t);
    const stranger = chain.transfer("0x000000000000000000000000000000000000dEaD", units("50"));
    chain.mine(3);
    const r = await watcher.poll();
    assert.deepEqual(r.outcomes, [{ kind: "ignored", reason: "unknown_address" }]);
    assert.equal(transitions.length, 0);
    assert.equal(await deps.db.claim(claimKey(stranger)), true, "the watcher didn't write it");
  });

  test("a second deposit to an already-paid address is an EXTRA deposit: not credited again", async (t) => {
    const { deps, chain, watcher, logs } = await setup(t);
    const { payment, address } = await bnbPayment(deps);
    chain.transfer(address, units("9.69"));
    chain.mine(3);
    await watcher.poll();
    chain.transfer(address, units("9.69"));
    chain.mine(3);
    const r = await watcher.poll();
    assert.deepEqual(r.outcomes, [{ kind: "extra", paymentId: payment.id, status: "authorized" }]);
    assert.equal(await statusOf(deps, payment.id), "authorized");
    assert.equal(count(logs, /EXTRA deposit to a payment that is already authorized/), 1);
  });

  test("late payments: within 1 h of quote expiry accepted (logged), later than that left created", async (t) => {
    const { deps, chain, watcher, logs } = await setup(t);
    const now = Date.now();
    const quoteAt = (expiresAt: number) => ({ local: money("12.50", "SGD"), usd: money("9.69", "USD"), rate: "1.2900", sendMaxUsd: "9.79", expiresAt: new Date(expiresAt).toISOString() });
    const late = await bnbPayment(deps, { quote: quoteAt(now - 20 * 60_000) });
    const tooLate = await bnbPayment(deps, { quote: quoteAt(now - 2 * 3600_000) });
    const onTime = await bnbPayment(deps, { quote: quoteAt(now + 60_000) });
    // the block time decides, not when the worker gets round to it
    chain.transfer(late.address, units("9.69"), { at: new Date(now) });
    chain.transfer(tooLate.address, units("9.69"), { block: chain.headBlock + 2n, at: new Date(now) });
    chain.transfer(onTime.address, units("9.69"), { block: chain.headBlock + 3n, at: new Date(now - 3 * 3600_000) });
    chain.mine(5);

    const r = await watcher.poll();
    assert.deepEqual(r.outcomes, [
      { kind: "authorized", paymentId: late.payment.id, late: true },
      { kind: "too_late", paymentId: tooLate.payment.id },
      { kind: "authorized", paymentId: onTime.payment.id, late: false },
    ]);
    assert.equal(await statusOf(deps, tooLate.payment.id), "created");
    assert.ok(logs.some((l) => /late deposit accepted/.test(l) && l.includes('"lateByMin":20')));
    assert.ok(logs.some((l) => /more than 1 h after the quote expired/.test(l) && l.includes('"lateByMin":120')));
  });

  test("an invoice already paid another way: the deposit is not authorized (unique index), logged for a manual refund", async (t) => {
    const { deps, chain, watcher, logs } = await setup(t);
    const inv = await deps.db.createInvoice({
      merchantId: "ahseng",
      kind: "invoice",
      to: MAYA,
      lines: [{ menuItemId: null, name: "Chicken rice", qty: 1, unit: money("12.50", "SGD") }],
      total: money("12.50", "SGD"),
    });
    await authorizedPayment(deps, { invoiceId: inv.id }); // paid by Apple Pay first
    const { payment, address } = await bnbPayment(deps, { invoiceId: inv.id });
    chain.transfer(address, units("9.69"));
    chain.mine(3);
    const r = await watcher.poll();
    assert.deepEqual(r.outcomes, [{ kind: "duplicate_invoice", paymentId: payment.id }]);
    assert.equal(await statusOf(deps, payment.id), "created");
    assert.equal(count(logs, /another payment already paid/), 1);
  });

  test("an RPC outage or a DB error holds the cursor; the next poll picks the deposit up", async (t) => {
    const { deps, chain, watcher } = await setup(t);
    const { payment, address } = await bnbPayment(deps);
    chain.transfer(address, units("9.69"));
    chain.mine(3);

    chain.failTransfers = 1;
    await assert.rejects(watcher.poll(), /fake RPC outage/);
    assert.equal(watcher.cursor(), 9_503n, "first poll set the boot cursor, then stopped");

    const orig = deps.db.getPaymentByDepositAddress.bind(deps.db);
    let fail = 1;
    deps.db.getPaymentByDepositAddress = async (a) => {
      if (fail-- > 0) throw new Error("connection terminated (fake)");
      return orig(a);
    };
    let r = await watcher.poll();
    assert.deepEqual(r.outcomes, []);
    assert.equal(r.cursor, 10_000n, "held just below the deposit's block");
    assert.equal(await statusOf(deps, payment.id), "created");

    r = await watcher.poll();
    assert.deepEqual(kinds(r.outcomes), ["authorized"]);
    assert.equal(r.cursor, 10_001n);
  });

  test("boot rescans `rescanBlocks` back, not from genesis; later polls scan only new blocks", async (t) => {
    const { deps, chain, watcher } = await setup(t, { rescanBlocks: 500n });
    const old = await bnbPayment(deps);
    const recent = await bnbPayment(deps);
    chain.transfer(old.address, units("9.69"), { block: 9_400n }); // before the window
    chain.transfer(recent.address, units("9.69"), { block: 9_600n }); // inside it
    const r = await watcher.poll();
    assert.deepEqual(chain.calls.transfers, [[9_501n, 10_000n]]);
    assert.deepEqual(r.outcomes, [{ kind: "authorized", paymentId: recent.payment.id, late: false }]);
    assert.equal(await statusOf(deps, old.payment.id), "created");

    chain.mine(4);
    await watcher.poll();
    assert.deepEqual(chain.calls.transfers.at(-1), [9_999n, 10_004n]); // from the last poll's confirmed head (10_000 − 2) + 1
  });
});
