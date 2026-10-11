// Auto-withdraw. Owner: Nithya · Task: NI-C4. Spec: docs/specs/withdrawals.md §3c (last bullet).
// PATCH /internal/merchants/:id/auto-withdraw { mode } → db.setAutoWithdraw (server.ts answers 204). The agent only
// calls it after the merchant confirmed the "auto-withdraw daily" pending action, which is what pre-confirms the
// nightly withdrawals below (no per-withdrawal confirmation or step-up).
// Job: from 21:00 Asia/Singapore, for each live merchant with autoWithdraw "daily" and available ≥ S$1.00, create a
// withdrawal of the full available balance (capped at what's left of the daily limit) to the default bank and execute
// it with actionId `auto:<merchantId>:<YYYY-MM-DD>`. db.claim on that key makes it at most once per merchant per day,
// across restarts. A merchant under S$1.00 isn't claimed, so a sale before midnight still gets swept that night.

import { cmp, sub, type Merchant, type MerchantId, type Money } from "@rove/shared";
import type { InternalSetAutoWithdrawReq } from "../contracts";
import type { WorkerDeps } from "../deps";
import { isUserFacingError, UserFacingError } from "../errors";
import { createWithdrawal, withdrawalLimits } from "./create";
import { executeWithdrawal } from "./execute";

export const AUTO_WITHDRAW_HOUR_SGT = 21;
const SGT_OFFSET_MS = 8 * 3600 * 1000; // Asia/Singapore is UTC+8 all year

export async function setAutoWithdraw(deps: WorkerDeps, merchantId: MerchantId, body: InternalSetAutoWithdrawReq): Promise<void> {
  const merchant = await deps.db.getMerchant(merchantId);
  if (!merchant) throw new UserFacingError("merchant_not_found", "I couldn't find that shop.", 404);
  await deps.db.setAutoWithdraw(merchantId, body.mode);
  deps.log.child("auto-withdraw").info("auto-withdraw set", { merchantId, mode: body.mode });
}

/** The Asia/Singapore calendar date (YYYY-MM-DD) and hour for an instant. */
export function sgtClock(now: Date): { date: string; hour: number } {
  const t = new Date(now.getTime() + SGT_OFFSET_MS);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

export type AutoWithdrawOutcome =
  | { merchantId: MerchantId; withdrawalId: string; amount: Money }
  | { merchantId: MerchantId; skipped: "below_minimum" | "daily_limit" | "already_ran" | "refused" | "error"; detail?: string };

/** One pass of the nightly job: does nothing before 21:00 SGT. Exported for tests and scripts. */
export async function runAutoWithdraw(deps: WorkerDeps): Promise<AutoWithdrawOutcome[]> {
  const { date, hour } = sgtClock(deps.now());
  if (hour < AUTO_WITHDRAW_HOUR_SGT) return [];
  const log = deps.log.child("auto-withdraw");
  const merchants = (await deps.db.listLiveMerchants()).filter((m) => m.autoWithdraw === "daily");
  const out: AutoWithdrawOutcome[] = [];
  for (const m of merchants) {
    try {
      out.push(await autoWithdrawOne(deps, m, date));
    } catch (err) {
      log.error("auto-withdraw crashed for merchant", { merchantId: m.id, err });
      out.push({ merchantId: m.id, skipped: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = out.filter((o) => "withdrawalId" in o);
  if (done.length) log.info("auto-withdraw run", { date, started: done.length });
  return out;
}

async function autoWithdrawOne(deps: WorkerDeps, m: Merchant, date: string): Promise<AutoWithdrawOutcome> {
  const log = deps.log.child("auto-withdraw");
  const limits = withdrawalLimits(m.currency);
  const { available } = await deps.db.getBalance(m.id);
  if (cmp(available, limits.min) < 0) return { merchantId: m.id, skipped: "below_minimum" };

  const left = sub(limits.dailyMax, await deps.db.withdrawnToday(m.id));
  const amount = cmp(available, left) <= 0 ? available : left;
  if (cmp(amount, limits.min) < 0) return { merchantId: m.id, skipped: "daily_limit" };

  const key = `auto:${m.id}:${date}`;
  if (!(await deps.db.claim(key))) return { merchantId: m.id, skipped: "already_ran" };

  try {
    const view = await createWithdrawal(deps, { merchantId: m.id, amount: amount.amount, destination: null });
    await executeWithdrawal(deps, view.id, { actionId: key });
    log.info("auto-withdraw started", { merchantId: m.id, id: view.id, amount: amount.amount });
    return { merchantId: m.id, withdrawalId: view.id, amount };
  } catch (err) {
    if (!isUserFacingError(err)) throw err;
    // e.g. no bank account on file: today's run is used up; the merchant can still say "withdraw".
    log.warn("auto-withdraw skipped", { merchantId: m.id, code: err.code, reason: err.message });
    return { merchantId: m.id, skipped: "refused", detail: err.message };
  }
}

/** Checks every config.intervals.autoWithdraw ms whether the nightly run is due. Returns a stopper. */
export function startAutoWithdrawJob(deps: WorkerDeps): () => void {
  const log = deps.log.child("auto-withdraw");
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAutoWithdraw(deps);
    } catch (err) {
      log.error("auto-withdraw run failed", { err });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.intervals.autoWithdraw);
  timer.unref?.();
  return () => clearInterval(timer);
}
