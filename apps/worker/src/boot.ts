// Boot-time recovery + the demo laptop's money log. Owner: Nithya · Task: NI-C7 (first version from NI-C1).
// index.ts calls boot(deps) right after the HTTP server and the jobs start.
// 0. money log: one readable line per money event (sale settled, withdrawal step, refund) with merchant, amount and an
//    explorer link. Installed synchronously, before boot's first await, so it's in place before any request or job
//    can emit (index.ts calls boot() in the same tick as startJobs()).
// 1. resume withdrawals that were mid-pipeline when the process stopped (withdrawals/execute.ts, NI-C4)
// 2. replay events the agent never acknowledged (same envelope ids; the agent dedupes on them)
// 3. one summary line: `boot: resumed 1 withdrawal(s) · replayed 3/3 undelivered event(s)`
// Never throws: a failed recovery step is logged and the worker keeps serving.

import { format, type EventEnvelope, type RoveEvent } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import type { Emit } from "./emit";
import type { Logger } from "./log";
import { resumeWithdrawals } from "./withdrawals/execute";

/** Statuses resumeWithdrawals picks up (withdrawals.md §3c "Recovery on boot"); counted here for the summary. */
export const RESUMABLE_WITHDRAWAL_STATUSES = ["approved", "onchain_pending", "onchain_settled", "payout_pending"] as const;
/** Undelivered events per page, and pages per boot (the rest waits for the next boot). */
export const REPLAY_PAGE = 200;
const REPLAY_MAX_PAGES = 10;
/** Stop replaying after this many failures in a row: the agent is down, and each failure costs ~17s of retries. */
export const REPLAY_GIVE_UP_AFTER = 3;

export interface BootSummary {
  /** Withdrawals found mid-pipeline and handed to resumeWithdrawals (null if they couldn't be counted). */
  withdrawalsResumed: number | null;
  /** Undelivered events found (null if they couldn't be read) / delivered now. */
  eventsPending: number | null;
  eventsDelivered: number;
  /** Steps that failed (also logged). */
  errors: string[];
}

export interface BootOptions {
  /** Injected in tests. Default: resumeWithdrawals from ./withdrawals/execute. */
  resume?: (deps: WorkerDeps) => Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function boot(deps: WorkerDeps, opts: BootOptions = {}): Promise<BootSummary> {
  installMoneyLog(deps);
  const log = deps.log.child("boot");
  const summary: BootSummary = { withdrawalsResumed: null, eventsPending: 0, eventsDelivered: 0, errors: [] };

  try {
    summary.withdrawalsResumed = (await deps.db.listWithdrawalsByStatus([...RESUMABLE_WITHDRAWAL_STATUSES])).length;
  } catch (err) {
    log.warn("couldn't count in-flight withdrawals", { err: errText(err) });
  }
  try {
    await (opts.resume ?? resumeWithdrawals)(deps);
  } catch (err) {
    summary.errors.push(`withdrawal resume: ${errText(err)}`);
    log.error("withdrawal resume failed", { err: errText(err) });
  }

  try {
    await replayEvents(deps, summary, log);
  } catch (err) {
    if (summary.eventsPending === 0) summary.eventsPending = null;
    summary.errors.push(`event replay: ${errText(err)}`);
    log.error("event replay failed", { err: errText(err) });
  }

  log.info(describeBoot(summary));
  return summary;
}

async function replayEvents(deps: WorkerDeps, summary: BootSummary, log: Logger): Promise<void> {
  const tried = new Set<string>();
  let failuresInRow = 0;
  for (let page = 0; page < REPLAY_MAX_PAGES; page++) {
    const pending = (await deps.db.listUndeliveredEvents(REPLAY_PAGE)).filter((e) => !tried.has(e.id));
    if (pending.length === 0) return;
    if (page === 0) log.info("replaying undelivered events", { count: pending.length, oldest: pending[0]!.at });
    summary.eventsPending = (summary.eventsPending ?? 0) + pending.length;
    for (const envelope of pending) {
      tried.add(envelope.id);
      if (await deps.emit.deliver(envelope)) {
        summary.eventsDelivered++;
        failuresInRow = 0;
      } else if (++failuresInRow >= REPLAY_GIVE_UP_AFTER) {
        log.warn("agent unreachable: stopped replaying; the rest stay in the events table for the next boot", {
          failedInRow: failuresInRow,
          agentUrl: deps.config.agentUrl,
        });
        return;
      }
    }
    if (pending.length < REPLAY_PAGE) return;
  }
}

/** `boot: resumed 1 withdrawal(s) · replayed 3/3 undelivered event(s)` */
export function describeBoot(s: BootSummary): string {
  const resumed = s.withdrawalsResumed === null ? "withdrawals: couldn't count" : `resumed ${s.withdrawalsResumed} withdrawal(s)`;
  const events =
    s.eventsPending === null
      ? "undelivered events: couldn't read"
      : s.eventsPending === 0
        ? "no undelivered events"
        : `replayed ${s.eventsDelivered}/${s.eventsPending} undelivered event(s)`;
  const errors = s.errors.length ? ` · ${s.errors.length} step(s) failed (see above)` : "";
  return `boot: ${resumed} · ${events}${errors}`;
}

// ------------------------------------------------------------------ money log (demo laptop)

const INSTALLED = Symbol.for("rove.worker.moneyLog");
type Marked = Emit & { [INSTALLED]?: true };

/**
 * Wraps deps.emit so every money event also prints one readable line. Every money step already emits exactly one event,
 * so this can't miss a step or disagree with what the agent was told. Idempotent (wraps once). The line is written
 * before delivery, so a slow or down agent never delays it.
 *   14:03:07 INFO  [worker:money] sale settled      ahseng        +S$12.50  pay_x  https://testnet.xrpl.org/transactions/…
 *   14:05:10 INFO  [worker:money] withdrawal        ahseng        S$5.00 → onchain_settled  wd_x  https://…
 *   14:06:00 INFO  [worker:money] refund            ahseng        −S$3.00  rf_x  https://…
 */
export function installMoneyLog(deps: WorkerDeps): void {
  const inner = deps.emit as Marked;
  if (inner[INSTALLED]) return;
  const log = deps.log.child("money");
  const wrapped = async (event: RoveEvent) => {
    try {
      await logMoneyEvent(deps, log, event);
    } catch {
      // A log line must never break the money path.
    }
    return inner(event);
  };
  const deliver = (envelope: EventEnvelope) => inner.deliver(envelope);
  deps.emit = Object.assign(wrapped, { deliver, [INSTALLED]: true as const });
}

const pad = (s: string, n: number) => s.padEnd(n);

/** The line for one event, or null if it isn't a money event. Exported for tests. */
export async function moneyLine(deps: Pick<WorkerDeps, "db" | "settlement">, event: RoveEvent): Promise<{ level: "info" | "warn"; line: string } | null> {
  const link = (hash: string | null | undefined) => (hash ? deps.settlement.explorerUrl(hash) : "(no tx)");
  switch (event.type) {
    case "payment.settled":
      return {
        level: "info",
        line: `${pad("sale settled", 18)}${pad(event.merchantId, 14)}+${format(event.local)}  ${event.paymentId}  ${link(event.txHash)}`,
      };
    case "payment.failed":
      return { level: "warn", line: `${pad("payment failed", 18)}${pad(event.merchantId, 14)}${event.paymentId}  ${event.reason}` };
    case "refund.completed": {
      let hash: string | undefined;
      try {
        hash = (await deps.db.getRefundByAction(event.actionId))?.xrplTxHash;
      } catch {
        hash = undefined;
      }
      return { level: "info", line: `${pad("refund", 18)}${pad(event.merchantId, 14)}−${format(event.amount)}  ${event.refundId}  ${link(hash)}` };
    }
    case "refund.failed":
      return { level: "warn", line: `${pad("refund failed", 18)}${pad(event.merchantId, 14)}${event.refundId}  ${event.reason}` };
    case "withdrawal.updated": {
      const bad = event.status === "failed" || event.status === "returned" || event.status === "cancelled";
      const extra = [event.bankRef ? `bank ref ${event.bankRef}` : null, event.failureReason ?? null].filter(Boolean).join(" · ");
      return {
        level: bad ? "warn" : "info",
        line:
          `${pad("withdrawal", 18)}${pad(event.merchantId, 14)}${format(event.amount)} → ${event.status}  ${event.withdrawalId}` +
          (event.sweepTxHash ? `  ${link(event.sweepTxHash)}` : "") +
          (extra ? `  (${extra})` : ""),
      };
    }
    default:
      return null;
  }
}

async function logMoneyEvent(deps: WorkerDeps, log: Logger, event: RoveEvent): Promise<void> {
  const out = await moneyLine(deps, event);
  if (out) log[out.level](out.line);
}
