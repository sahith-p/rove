// NI-C4 · auto-withdraw: PATCH …/auto-withdraw and the 21:00 SGT nightly run (withdrawals.md §3c, last bullet).

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { isUserFacingError } from "../errors";
import { createServer } from "../server";
import { TEST_INTERNAL_SECRET } from "../testing";
import { runAutoWithdraw, setAutoWithdraw, sgtClock, startAutoWithdrawJob } from "./auto";
import { idle } from "./lock";
import { startPartnerCallbacks } from "./partner";
import { addMerchant, closeFixtures, dbSkipReason, waitForStatus, withdrawalFixture } from "./testkit";

const skip = await dbSkipReason();
const AT_2105_SGT = new Date("2026-10-11T13:05:00Z");
const AT_2059_SGT = new Date("2026-10-11T12:59:00Z");

test("sgtClock: Asia/Singapore date and hour (UTC+8, crosses midnight)", () => {
  assert.deepEqual(sgtClock(AT_2105_SGT), { date: "2026-10-11", hour: 21 });
  assert.deepEqual(sgtClock(new Date("2026-10-11T16:30:00Z")), { date: "2026-10-12", hour: 0 });
});

describe("auto-withdraw (NI-C4)", { skip }, () => {
  after(closeFixtures);

  test("setAutoWithdraw sets the mode; unknown shop → 404; PATCH answers 204", async () => {
    const fx = await withdrawalFixture();
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    assert.equal((await fx.deps.db.getMerchant(fx.merchantId))?.autoWithdraw, "daily");
    await assert.rejects(setAutoWithdraw(fx.deps, "nobody", { mode: "daily" }), (err: unknown) => isUserFacingError(err) && err.status === 404);

    const app = createServer(fx.deps);
    const res = await app.request(`/internal/merchants/${fx.merchantId}/auto-withdraw`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "off" }),
    });
    assert.equal(res.status, 204);
    assert.equal((await fx.deps.db.getMerchant(fx.merchantId))?.autoWithdraw, "off");
  });

  test("21:05 SGT: full available balance to the default bank, executed, once per merchant per day", async () => {
    const fx = await withdrawalFixture({ balance: "118.40", overrides: { now: () => AT_2105_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    const off = await addMerchant(fx.deps, fx.fast);
    await off.addBank();
    await off.seed("50");
    const stop = startPartnerCallbacks(fx.deps);
    try {
      const out = await runAutoWithdraw(fx.deps);
      assert.equal(out.length, 1, "only merchants with auto-withdraw daily");
      const first = out[0]!;
      assert.ok("withdrawalId" in first, JSON.stringify(first));
      assert.equal(first.amount.amount, "118.40");

      const w = await waitForStatus(fx.deps, first.withdrawalId, ["completed"]);
      await idle(first.withdrawalId);
      assert.equal(w.destination.kind, "bank");
      assert.deepEqual((await fx.deps.db.getBalance(fx.merchantId)).available.amount, "0.00");
      assert.ok((await fx.reconciled()).ok);

      // New sale, same evening: the day's run already happened.
      await fx.seed("6.50");
      assert.deepEqual(await runAutoWithdraw(fx.deps), [{ merchantId: fx.merchantId, skipped: "already_ran" }]);
      assert.equal((await fx.deps.db.listWithdrawals(fx.merchantId)).length, 1);
      assert.equal((await fx.deps.db.listWithdrawals(off.merchantId)).length, 0);

      // The next day runs again.
      const nextDay = { ...fx.deps, now: () => new Date(AT_2105_SGT.getTime() + 24 * 3600 * 1000) };
      const again = await runAutoWithdraw(nextDay);
      assert.ok("withdrawalId" in again[0]!);
      await waitForStatus(fx.deps, (again[0] as { withdrawalId: string }).withdrawalId, ["completed"]);
    } finally {
      stop();
    }
  });

  test("before 21:00 SGT nothing happens", async () => {
    const fx = await withdrawalFixture({ balance: "50", overrides: { now: () => AT_2059_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    assert.deepEqual(await runAutoWithdraw(fx.deps), []);
    assert.equal((await fx.deps.db.listWithdrawals(fx.merchantId)).length, 0);
  });

  test("under S$1.00 is skipped without using up the day; a later sale that evening is swept", async () => {
    const fx = await withdrawalFixture({ balance: "0.50", overrides: { now: () => AT_2105_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    assert.deepEqual(await runAutoWithdraw(fx.deps), [{ merchantId: fx.merchantId, skipped: "below_minimum" }]);
    await fx.seed("9.50");
    const out = await runAutoWithdraw(fx.deps);
    assert.ok("withdrawalId" in out[0]!);
    assert.equal((out[0] as { amount: { amount: string } }).amount.amount, "10.00");
    await idle((out[0] as { withdrawalId: string }).withdrawalId);
  });

  test("capped at what's left of the S$2,000 daily limit", async () => {
    const fx = await withdrawalFixture({ balance: "2600", overrides: { now: () => AT_2105_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    const out = await runAutoWithdraw(fx.deps);
    assert.equal((out[0] as { amount: { amount: string } }).amount.amount, "2000.00");
    await idle((out[0] as { withdrawalId: string }).withdrawalId);
  });

  test("no bank account: refused and logged; the day is used up", async () => {
    const fx = await withdrawalFixture({ balance: "50", bank: false, overrides: { now: () => AT_2105_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" });
    const [first] = await runAutoWithdraw(fx.deps);
    assert.deepEqual(first, { merchantId: fx.merchantId, skipped: "refused", detail: "Add your bank first: say 'add my bank'." });
    assert.ok(fx.logs.some((l) => l.level === "warn" && l.line.includes("auto-withdraw skipped")));
    assert.deepEqual(await runAutoWithdraw(fx.deps), [{ merchantId: fx.merchantId, skipped: "already_ran" }]);
  });

  test("the job ticks on its interval and runs once; the stopper stops it", async () => {
    const fx = await withdrawalFixture({ balance: "25", overrides: { now: () => AT_2105_SGT } });
    await setAutoWithdraw(fx.deps, fx.merchantId, { mode: "daily" }); // TEST_CONFIG: every 50ms
    const stop = startAutoWithdrawJob(fx.deps);
    try {
      const until = Date.now() + 3000;
      while ((await fx.deps.db.listWithdrawals(fx.merchantId)).length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200)); // several more ticks
      const list = await fx.deps.db.listWithdrawals(fx.merchantId);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.amount.amount, "25.00");
      await idle(list[0]!.id);
    } finally {
      stop();
    }
  });
});
