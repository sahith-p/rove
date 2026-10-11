// Settlement: authorized payment → the merchant's stablecoin (XSGD, EUR, …) in their custodial account. Owner: Nithya ·
// Task: NI-C2. Spec: docs/specs/settlement-xrpl.md §4, docs/specs/payments-stripe.md §1a + §7, docs/specs/corridors.md.
//
// POST /internal/settle (server.ts) awaits handleSettle() and then answers 202, so handleSettle returns quickly:
// it checks the payment exists and schedules settlePayment() without awaiting it. The poller picks up anything a
// lost nudge missed. Idempotent on paymentId: the authorized → settling compare-and-set lets exactly one run through.
//
// settlePayment:
//   CAS authorized → settling
//   settle() on XRPL from the payer's currency (= the charge currency; bnb/ausd → USD) with the stored route's SendMax
//     (quote.sendMax in that currency): same currency → direct (EUR → EUR), else one Payment through the RLUSD hub
//     (USD → EUR, EUR → RLUSD → XSGD)
//     path error (tecPATH_PARTIAL / tecPATH_DRY) or expired quote → fresh quote({ local, from }), retry; at most 2 retries
//     other XRPL rejection → fail now; unknown outcome (timeout etc.) → leave `settling` for review (never pay twice)
//   delivered_amount must equal local exactly, else fail loudly without crediting (ledger invariant)
//   db.completeSettlement (settled + ledger payment_credit + invoice paid + contact) → emit payment.settled (firstSale)
//   final failure: CAS settling → failed, full Stripe refund of the PI (bnb/ausd: token refund pending review), payment.failed
//
// Payments found in `settling` that this process isn't working on (a crash mid-settle, an unknown XRPL outcome) are
// NOT re-settled automatically: the transaction may already be on the ledger. The poller logs them once for review.

import { createHash } from "node:crypto";
import {
  cmp,
  format,
  money,
  type Currency,
  type Payment,
  type PaymentMethod,
  type PaymentId,
  type Quote,
  type SettleResult,
} from "@rove/shared";
import type { InternalSettleReq } from "./contracts";
import type { WorkerDeps } from "./deps";
import { UserFacingError } from "./errors";
import type { Logger } from "./log";
import { serialFor, type Serial } from "./settle/serial";
import { classifyXrplError, errorMessage, type ClassifiedError } from "./settle/xrpl-errors";

/** Retries after the first attempt, each with a fresh quote (payments-stripe.md §7). */
export const SETTLE_MAX_RETRIES = 2;
/** A payment in `settling` this long, and not being worked on here, is reported for review. */
export const SETTLE_STUCK_AFTER_MS = 60_000;

type Outcome =
  | { kind: "settled"; result: SettleResult; delivered: string }
  /** Nothing was credited and it's safe to fail + refund (no XRPL money moved, or delivered ≠ local: see txHash). */
  | { kind: "failed"; reason: string; txHash?: string }
  /** The XRPL transaction may have gone through: don't fail, don't retry, leave `settling` for a human. */
  | { kind: "review"; reason: string };

interface SettleState {
  serial: Serial; // one settlement at a time per merchant
  inFlight: Map<PaymentId, Promise<void>>;
  reportedStuck: Set<PaymentId>;
}

const serials = new WeakMap<object, Serial>();
const states = new WeakMap<object, SettleState>();

function stateFor(deps: WorkerDeps): SettleState {
  let s = states.get(deps.db);
  if (!s) {
    s = { serial: serialFor(serials, deps.db), inFlight: new Map(), reportedStuck: new Set() };
    states.set(deps.db, s);
  }
  return s;
}

/** XRPL InvoiceID for a payment (settlement-xrpl.md §4): how to find its transaction on the explorer. */
export function invoiceIdHex(paymentId: PaymentId): string {
  return createHash("sha256").update(paymentId).digest("hex").toUpperCase();
}

/** Stablecoin pay-ins (USDT on BNB Chain, AUSD on Base): no Stripe PaymentIntent; returning tokens is manual. */
export function isTokenPayment(method: PaymentMethod): boolean {
  return method === "bnb" || method === "ausd";
}

/** Which treasury float pays: the currency the payer was charged in. Token pay-ins (bnb, ausd) are always USD. */
export function settleFrom(payment: Pick<Payment, "method" | "charge">): Currency {
  if (isTokenPayment(payment.method)) return "USD";
  return payment.charge?.currency ?? "USD";
}

// ------------------------------------------------------------------ entry points

export async function handleSettle(deps: WorkerDeps, body: InternalSettleReq): Promise<void> {
  const payment = await deps.db.getPayment(body.paymentId);
  if (!payment) throw new UserFacingError("payment_not_found", "That payment doesn't exist.", 404);
  if (payment.status !== "authorized") {
    deps.log.child("settle").debug("settle nudge ignored", { paymentId: payment.id, status: payment.status });
    return;
  }
  void scheduleSettle(deps, payment); // not awaited: the route answers 202 now
}

/**
 * Queue a settlement behind any other settlement for the same merchant; joins the run already queued for this payment.
 * Never rejects (errors are logged). The nudge, the poller and the BNB watcher should all come through here.
 */
export function scheduleSettle(deps: WorkerDeps, payment: Pick<Payment, "id" | "merchantId">): Promise<void> {
  const st = stateFor(deps);
  const existing = st.inFlight.get(payment.id);
  if (existing) return existing;
  const run = st.serial
    .run(payment.merchantId, () => settlePayment(deps, payment.id))
    .catch((err) => deps.log.child("settle").error("settlement crashed", { paymentId: payment.id, err: errorMessage(err) }))
    .finally(() => st.inFlight.delete(payment.id));
  st.inFlight.set(payment.id, run);
  return run;
}

export async function settlePayment(deps: WorkerDeps, paymentId: PaymentId): Promise<void> {
  const log = deps.log.child("settle");
  const payment = await deps.db.transitionPayment(paymentId, ["authorized"], "settling");
  if (!payment) {
    log.debug("not authorized (already taken, or not paid yet); skipping", { paymentId });
    return;
  }
  const from = settleFrom(payment);
  log.info("settling", { paymentId, merchantId: payment.merchantId, local: format(payment.local), from });

  const ctx = { submitted: false };
  let outcome: Outcome;
  try {
    outcome = await attemptSettle(deps, payment, from, ctx, log);
  } catch (err) {
    // A bug or a DB error outside the engine call. Before anything went to XRPL it's a clean failure; after, review.
    const reason = `settlement error: ${errorMessage(err)}`;
    outcome = ctx.submitted ? { kind: "review", reason } : { kind: "failed", reason };
  }

  switch (outcome.kind) {
    case "settled":
      return finishSettled(deps, payment, outcome.result, outcome.delivered, log);
    case "failed":
      return failPayment(deps, payment, outcome.reason, outcome.txHash, log);
    case "review":
      log.error("XRPL outcome unknown: payment left in settling for review (not retried, not refunded: it may already be paid)", {
        paymentId,
        merchantId: payment.merchantId,
        reason: outcome.reason,
        invoiceId: invoiceIdHex(paymentId),
      });
      return;
  }
}

// ------------------------------------------------------------------ the XRPL part

/**
 * The quote's SendMax in `from` (the payer's float): `quote.sendMax` when the quote was made from `from` (quote.pay is in
 * that currency); from USD, the USD route (`sendMaxUsd`) always is one. Undefined → the stored quote is for another
 * float (e.g. a payment from before the route was stored): re-quote with `from`.
 */
export function routeFrom(quote: Quote, from: Currency): string | undefined {
  if (quote.pay && quote.sendMax !== undefined && quote.pay.currency === from) return quote.sendMax;
  if (from === "USD") return quote.sendMaxUsd;
  return undefined;
}

function quoteExpired(quote: Quote, now: Date): boolean {
  const t = Date.parse(quote.expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

function describe(c: ClassifiedError | null): string {
  if (!c) return "unknown error";
  if (c.kind === "path") return c.code ? `no XRPL path with enough liquidity (${c.code})` : c.message;
  return c.code ? `XRPL rejected the payment (${c.code})` : c.message;
}

async function attemptSettle(
  deps: WorkerDeps,
  payment: Payment,
  from: Currency,
  ctx: { submitted: boolean },
  log: Logger,
): Promise<Outcome> {
  const merchant = await deps.db.getMerchant(payment.merchantId);
  if (!merchant?.xrplAddress) return { kind: "failed", reason: `merchant ${payment.merchantId} has no XRPL account` };
  const merchantAddress = merchant.xrplAddress;

  let quote = payment.quote;
  let last: ClassifiedError | null = null;
  const attempts = SETTLE_MAX_RETRIES + 1;
  // Same currency (EUR payer → EUR shop, SGD → SGD): that float pays directly, no swap, so no SendMax matters.
  const swap = from !== payment.local.currency;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const needQuote = !quote || (swap && (attempt > 1 || quoteExpired(quote, deps.now()) || !routeFrom(quote, from)));
    if (needQuote) {
      try {
        quote = await deps.settlement.quote({ local: payment.local, from });
        log.info("fresh quote", {
          paymentId: payment.id,
          attempt,
          from,
          pay: quote.pay ? format(quote.pay) : format(quote.usd),
          sendMax: quote.sendMax ?? quote.sendMaxUsd,
        });
      } catch (err) {
        last = { kind: "path", code: null, message: `quote failed: ${errorMessage(err)}` };
        log.warn("quote failed", { paymentId: payment.id, attempt, error: last.message });
        continue;
      }
    }

    ctx.submitted = true;
    try {
      const sendMax = routeFrom(quote!, from);
      const result = await deps.settlement.settle({
        paymentId: payment.id,
        merchantAddress,
        local: payment.local,
        sendMaxUsd: quote!.sendMaxUsd,
        from,
        ...(sendMax ? { sendMax } : {}),
      });
      return checkDelivered(payment, result);
    } catch (err) {
      const c = classifyXrplError(err);
      last = c;
      log.warn("settle attempt failed", { paymentId: payment.id, attempt, of: attempts, kind: c.kind, code: c.code, error: c.message });
      if (c.kind === "ambiguous") return { kind: "review", reason: c.message };
      if (c.kind === "mismatch") return { kind: "failed", reason: `${c.message}; not credited`, ...(c.txHash ? { txHash: c.txHash } : {}) };
      if (c.kind === "definitive") return { kind: "failed", reason: describe(c) };
      // path / retry: go round again with a fresh quote
    }
  }
  return { kind: "failed", reason: `${describe(last)}, after ${attempts} attempts` };
}

/** Credit only what XRPL says was delivered, and only if it's exactly the sale amount. */
function checkDelivered(payment: Payment, result: SettleResult): Outcome {
  let delivered: string | null = null;
  try {
    delivered = money(result.delivered, payment.local.currency).amount;
  } catch {
    delivered = null;
  }
  if (delivered === null || cmp({ amount: delivered, currency: payment.local.currency }, payment.local) !== 0) {
    return {
      kind: "failed",
      reason: `XRPL delivered ${result.delivered} instead of ${payment.local.amount} ${payment.local.currency}; not credited`,
      txHash: result.txHash,
    };
  }
  return { kind: "settled", result, delivered };
}

// ------------------------------------------------------------------ outcomes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function finishSettled(deps: WorkerDeps, payment: Payment, result: SettleResult, delivered: string, log: Logger): Promise<void> {
  const ctx = { paymentId: payment.id, merchantId: payment.merchantId, txHash: result.txHash };
  let done: Awaited<ReturnType<WorkerDeps["db"]["completeSettlement"]>> = null;
  for (let i = 1; ; i++) {
    try {
      done = await deps.db.completeSettlement(payment.id, { txHash: result.txHash, delivered });
      break;
    } catch (err) {
      if (i >= 3) {
        log.error("settled on XRPL but recording it failed: payment left in settling for review", { ...ctx, delivered, err: errorMessage(err) });
        return;
      }
      log.warn("recording the settlement failed; retrying", { ...ctx, attempt: i, err: errorMessage(err) });
      await sleep(250 * i);
    }
  }
  if (!done) {
    log.error("settled on XRPL but the payment was no longer settling: not credited, needs review", { ...ctx, delivered });
    return;
  }
  const { payment: settled, firstSale } = done;
  log.info("settled", {
    ...ctx,
    local: format(settled.local),
    delivered,
    firstSale,
    explorer: deps.settlement.explorerUrl(result.txHash),
  });
  await deps.emit({
    type: "payment.settled",
    paymentId: settled.id,
    merchantId: settled.merchantId,
    source: settled.source,
    invoiceId: settled.invoiceId,
    local: settled.local,
    payer: settled.payer,
    txHash: result.txHash,
    delivered,
    firstSale,
  });
}

async function failPayment(deps: WorkerDeps, payment: Payment, reason: string, txHash: string | undefined, log: Logger): Promise<void> {
  // A txHash here means XSGD did reach the merchant, but not the right amount: keep it for whoever reconciles.
  const failed = await deps.db.transitionPayment(payment.id, ["settling"], "failed", {
    failureReason: reason,
    ...(txHash ? { settleTxHash: txHash } : {}),
  });
  if (!failed) {
    log.warn("payment was no longer settling; leaving it", { paymentId: payment.id });
    return;
  }
  const ctx = { paymentId: payment.id, merchantId: payment.merchantId };
  log.error("payment failed", { ...ctx, reason, ...(txHash ? { txHash, note: "the stablecoin moved but was not credited: reconcile by hand" } : {}) });
  await refundPayer(deps, failed, log);
  await deps.emit({ type: "payment.failed", paymentId: payment.id, merchantId: payment.merchantId, reason });
}

/** Full refund of what the payer was charged. Idempotent on the payment id. Never throws. */
async function refundPayer(deps: WorkerDeps, payment: Payment, log: Logger): Promise<void> {
  const ctx = { paymentId: payment.id, merchantId: payment.merchantId, charge: payment.charge ? format(payment.charge) : undefined };
  if (isTokenPayment(payment.method)) {
    const token = payment.method === "bnb" ? "USDT (BNB Chain)" : "AUSD (Base)";
    log.warn(`${payment.method} payment failed to settle: ${token} refund pending review (send it back to the payer by hand)`, ctx);
    return;
  }
  const pi = payment.stripePaymentIntentId;
  if (!pi) {
    log.error("no Stripe PaymentIntent on this payment: refund the payer by hand", ctx);
    return;
  }
  if (!deps.stripe) {
    log.error("Stripe isn't configured (STRIPE_SECRET_KEY): refund the payer by hand", { ...ctx, paymentIntent: pi });
    return;
  }
  try {
    const refund = await deps.stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `settle-fail:${payment.id}` });
    log.info("payer refunded by Stripe", { ...ctx, stripeRefundId: refund.id, status: refund.status });
  } catch (err) {
    log.error("Stripe auto-refund failed: refund the payer by hand", { ...ctx, paymentIntent: pi, err: errorMessage(err) });
  }
}

// ------------------------------------------------------------------ poller

/** Schedules every `authorized` payment (per merchant, one at a time). Resolves with the scheduled runs. */
async function scheduleAuthorized(deps: WorkerDeps): Promise<Promise<void>[]> {
  const authorized = await deps.db.listPaymentsByStatus(["authorized"], 100);
  const st = stateFor(deps);
  const fresh = authorized.filter((p) => !st.inFlight.has(p.id));
  if (fresh.length) deps.log.child("settle").info("poller picked up authorized payments", { count: fresh.length });
  return authorized.map((p) => scheduleSettle(deps, p));
}

/** Logs (once per process) payments sitting in `settling` that nothing here is working on. Never re-settles them. */
async function reportStuck(deps: WorkerDeps): Promise<void> {
  const st = stateFor(deps);
  const settling = await deps.db.listPaymentsByStatus(["settling"], 100);
  const now = deps.now().getTime();
  const stillSettling = new Set(settling.map((p) => p.id));
  for (const id of st.reportedStuck) if (!stillSettling.has(id)) st.reportedStuck.delete(id);
  for (const p of settling) {
    if (st.inFlight.has(p.id) || st.reportedStuck.has(p.id)) continue;
    if (now - Date.parse(p.updatedAt) < SETTLE_STUCK_AFTER_MS) continue;
    st.reportedStuck.add(p.id);
    deps.log.child("settle").error("payment stuck in settling: NOT re-settling automatically (it may already be paid on XRPL). " +
      "Look up the treasury's Payment with this InvoiceID, then finish or fail it by hand", {
      paymentId: p.id,
      merchantId: p.merchantId,
      local: format(p.local),
      since: p.updatedAt,
      invoiceId: invoiceIdHex(p.id),
    });
  }
}

/** One poll: settle every authorized payment (waits for them) and report stuck ones. Used by the poller and tests. */
export async function pollSettlements(deps: WorkerDeps): Promise<void> {
  await Promise.all(await scheduleAuthorized(deps));
  await reportStuck(deps);
}

/** Every config.intervals.settlePoll ms: settle `authorized` payments. Returns a stopper. */
export function startSettlePoller(deps: WorkerDeps): () => void {
  const log = deps.log.child("settle");
  let stopped = false;
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // Don't wait for the settlements themselves: one slow XRPL call mustn't hold up other merchants' payments.
      void Promise.all(await scheduleAuthorized(deps));
      await reportStuck(deps);
    } catch (err) {
      log.error("settle poll failed", { err: errorMessage(err) });
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.config.intervals.settlePoll);
  timer.unref?.();
  void tick();
  log.info("settle poller started", { everyMs: deps.config.intervals.settlePoll });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
