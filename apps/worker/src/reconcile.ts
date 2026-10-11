// Reconciler. Owner: Nithya · Task: NI-C7. Spec: docs/specs/withdrawals.md §1.
// Invariant: ledger available + held == XSGD balance on the merchant's XRPL account (settlement.balance).
//
// Every config.intervals.reconcile ms, for each live merchant with an XRPL account: read the ledger balance, read
// XRPL, compare exactly (money.ts, minor units). One readable line per merchant for the demo laptop:
//   14:03:07 INFO  [worker:reconcile] ahseng        ledger S$25.00 = XRPL S$25.00 ✓
//   14:03:07 ERROR [worker:reconcile] DRIFT ahseng  ledger S$25.00 ≠ XRPL S$20.00 · XRPL holds S$5.00 less than the ledger …
// A mismatch is re-read once after a short pause before it's called drift: a settlement or withdrawal step that lands
// between the two reads (XRPL validated, ledger row a moment later) isn't drift. The last result per merchant stays in
// memory and is served read-only at GET /internal/reconcile (server.ts). Drift is reported, never "fixed": a human
// decides which side is wrong (settle.ts and refunds.ts log the tx hash whenever XSGD moved without a ledger entry).

import { add, cmp, DECIMALS, format, fromUnits, sub, toMinor, type Balance, type MerchantId, type Money } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import type { Logger } from "./log";

/** Pause before re-reading a mismatch (ms). Long enough for an in-flight settlement to record its ledger entry. */
export const RECONCILE_CONFIRM_DELAY_MS = 3000;

export type ReconcileStatus = "ok" | "drift" | "error";

export interface ReconcileResult {
  merchantId: MerchantId;
  xrplAddress: string | null;
  status: ReconcileStatus;
  /** status === "ok": ledger available + held equals the XSGD on XRPL, to the cent. */
  ok: boolean;
  /** Ledger available + held. */
  ledger: Money;
  available: Money;
  held: Money;
  /** XSGD on the merchant's XRPL account; null when it couldn't be read (status "error"). */
  onchain: Money | null;
  /**
   * onchain − ledger as a signed decimal string in the ledger's currency ("0.00", "-5.00"). Positive: XRPL holds more
   * than the ledger knows about. A plain string because money.ts amounts are never negative. Null when onchain is.
   */
  diff: string | null;
  /** Payments settling + withdrawals mid-chain for this merchant when a drift was seen (helps explain it). */
  inFlight?: number;
  /** Why the check couldn't run (status "error"). */
  error?: string;
  checkedAt: string;
}

export interface ReconcileSnapshot {
  engine: "mock" | "real";
  everyMs: number;
  /** When the last full pass finished; null before the first one. */
  lastRunAt: string | null;
  /** Every merchant checked in the last pass is ok. False when nothing was checked yet. */
  ok: boolean;
  merchants: ReconcileResult[];
}

export interface ReconcileOptions {
  /** Pause before re-reading a mismatch. Default RECONCILE_CONFIRM_DELAY_MS; tests pass 0. */
  confirmDelayMs?: number;
}

interface ReconcileState {
  results: Map<MerchantId, ReconcileResult>;
  lastRunAt: string | null;
}

const states = new WeakMap<object, ReconcileState>();

function stateFor(deps: WorkerDeps): ReconcileState {
  let s = states.get(deps.db);
  if (!s) {
    s = { results: new Map(), lastRunAt: null };
    states.set(deps.db, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const total = (b: Balance) => add(b.available, b.held);
const same = (a: Money, b: Money) => a.currency === b.currency && toMinor(a) === toMinor(b);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Merchant ids are short slugs; pad so the ledger/XRPL columns line up across merchants. */
const col = (id: string) => id.padEnd(12);

// ------------------------------------------------------------------ one merchant

/** Compare one merchant's ledger with XRPL, remember the result and log one line. Never throws. */
export async function reconcileMerchant(deps: WorkerDeps, merchantId: MerchantId, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const log = deps.log.child("reconcile");
  const result = await check(deps, merchantId, opts.confirmDelayMs ?? RECONCILE_CONFIRM_DELAY_MS);
  stateFor(deps).results.set(merchantId, result);
  logResult(log, result, deps.config.useMockSettlement);
  return result;
}

async function check(deps: WorkerDeps, merchantId: MerchantId, confirmDelayMs: number): Promise<ReconcileResult> {
  const checkedAt = () => deps.now().toISOString();
  let merchant: Awaited<ReturnType<WorkerDeps["db"]["getMerchant"]>>;
  let balance: Balance;
  try {
    merchant = await deps.db.getMerchant(merchantId);
    balance = await deps.db.getBalance(merchantId);
  } catch (err) {
    return errorResult(merchantId, null, null, `couldn't read the ledger: ${errText(err)}`, checkedAt());
  }
  if (!merchant) return errorResult(merchantId, null, balance, "no such merchant", checkedAt());
  const address = merchant.xrplAddress;
  if (!address) return errorResult(merchantId, null, balance, "merchant has no XRPL account yet", checkedAt());

  let onchain: Money;
  try {
    onchain = await deps.settlement.balance({ merchantAddress: address });
  } catch (err) {
    return errorResult(merchantId, address, balance, `couldn't read XRPL: ${errText(err)}`, checkedAt());
  }

  if (!same(total(balance), onchain)) {
    // Maybe a settlement / withdrawal step landed between the two reads: look again before calling it drift.
    if (confirmDelayMs > 0) await sleep(confirmDelayMs);
    try {
      balance = await deps.db.getBalance(merchantId);
      onchain = await deps.settlement.balance({ merchantAddress: address });
    } catch (err) {
      return errorResult(merchantId, address, balance, `re-check failed: ${errText(err)}`, checkedAt());
    }
  }

  const ledger = total(balance);
  if (ledger.currency !== onchain.currency) {
    return errorResult(merchantId, address, balance, `ledger is in ${ledger.currency} but XRPL reports ${onchain.currency}`, checkedAt());
  }
  const ok = same(ledger, onchain);
  const result: ReconcileResult = {
    merchantId,
    xrplAddress: address,
    status: ok ? "ok" : "drift",
    ok,
    ledger,
    available: balance.available,
    held: balance.held,
    onchain,
    diff: fromUnits(toMinor(onchain) - toMinor(ledger), DECIMALS[ledger.currency]),
    checkedAt: checkedAt(),
  };
  if (!ok) result.inFlight = await inFlightFor(deps, merchantId);
  return result;
}

function errorResult(merchantId: MerchantId, address: string | null, balance: Balance | null, error: string, checkedAt: string): ReconcileResult {
  const zero: Money = { amount: "0.00", currency: "SGD" };
  return {
    merchantId,
    xrplAddress: address,
    status: "error",
    ok: false,
    ledger: balance ? total(balance) : zero,
    available: balance?.available ?? zero,
    held: balance?.held ?? zero,
    onchain: null,
    diff: null,
    error,
    checkedAt,
  };
}

/** Best effort: how many of this merchant's payments are settling and withdrawals are between approval and the chain. */
async function inFlightFor(deps: WorkerDeps, merchantId: MerchantId): Promise<number | undefined> {
  try {
    const [payments, withdrawals] = await Promise.all([
      deps.db.listPaymentsByStatus(["settling"], 100),
      deps.db.listWithdrawalsByStatus(["approved", "onchain_pending"]),
    ]);
    return payments.filter((p) => p.merchantId === merchantId).length + withdrawals.filter((w) => w.merchantId === merchantId).length;
  } catch {
    return undefined;
  }
}

/** The one line per merchant. Exported for tests. */
export function describeResult(r: ReconcileResult): string {
  if (r.status === "error") return `${col(r.merchantId)}ledger ${format(r.ledger)} vs XRPL ?  (${r.error})`;
  const onchain = r.onchain!;
  if (r.ok) return `${col(r.merchantId)}ledger ${format(r.ledger)} = XRPL ${format(onchain)} ✓`;
  const gap =
    cmp(onchain, r.ledger) > 0
      ? `XRPL holds ${format(sub(onchain, r.ledger))} more than the ledger`
      : `XRPL holds ${format(sub(r.ledger, onchain))} less than the ledger`;
  const parts = [
    `DRIFT ${col(r.merchantId)}ledger ${format(r.ledger)} ≠ XRPL ${format(onchain)}`,
    gap,
    `available ${format(r.available)}, held ${format(r.held)}`,
    r.xrplAddress ? `account ${short(r.xrplAddress)}` : null,
    r.inFlight ? `${r.inFlight} payment/withdrawal step(s) in flight: if this persists, check them first` : null,
    "not auto-fixed: find the tx without a ledger entry (or the entry without a tx)",
  ];
  return parts.filter(Boolean).join(" · ");
}

function logResult(log: Logger, r: ReconcileResult, mock: boolean): void {
  const line = describeResult(r);
  if (r.status === "ok") log.info(line);
  // The mock engine keeps balances in memory, so any restart "drifts" every merchant with ledger history: not an alarm.
  else if (r.status === "drift" && mock) log.warn(`${line} (mock engine: its balances reset when the worker restarts)`);
  else if (r.status === "drift") log.error(line);
  else log.warn(line);
}

// ------------------------------------------------------------------ every merchant

/** One pass over every live merchant with an XRPL account (one at a time: a handful of cheap XRPL reads). */
export async function reconcileAll(deps: WorkerDeps, opts: ReconcileOptions = {}): Promise<ReconcileResult[]> {
  const st = stateFor(deps);
  const merchants = (await deps.db.listLiveMerchants()).filter((m) => m.xrplAddress);
  const results: ReconcileResult[] = [];
  for (const m of merchants) results.push(await reconcileMerchant(deps, m.id, opts));
  // Forget merchants that are no longer live / no longer have an account, so the endpoint shows the current set.
  const seen = new Set(merchants.map((m) => m.id));
  for (const id of st.results.keys()) if (!seen.has(id)) st.results.delete(id);
  st.lastRunAt = deps.now().toISOString();
  if (merchants.length === 0) deps.log.child("reconcile").debug("no live merchants with an XRPL account yet");
  return results;
}

/** What GET /internal/reconcile serves: the last result per merchant. Read-only; doesn't trigger a check. */
export function reconcileSnapshot(deps: WorkerDeps): ReconcileSnapshot {
  const st = stateFor(deps);
  const merchants = [...st.results.values()].sort((a, b) => a.merchantId.localeCompare(b.merchantId));
  return {
    engine: deps.config.useMockSettlement ? "mock" : "real",
    everyMs: deps.config.intervals.reconcile,
    lastRunAt: st.lastRunAt,
    ok: merchants.length > 0 && merchants.every((r) => r.ok),
    merchants,
  };
}

/** Every config.intervals.reconcile ms (first pass right away). Returns a stopper. */
export function startReconciler(deps: WorkerDeps, opts: ReconcileOptions = {}): () => void {
  const log = deps.log.child("reconcile");
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileAll(deps, opts);
    } catch (err) {
      log.error("reconcile pass failed", { err: errText(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.intervals.reconcile);
  timer.unref?.();
  void tick();
  log.info("reconciler started", { everyMs: deps.config.intervals.reconcile, engine: deps.config.useMockSettlement ? "mock" : "real" });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
