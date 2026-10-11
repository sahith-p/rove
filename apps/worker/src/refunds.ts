// Refunds. Owner: Nithya · Task: NI-C5. Spec: docs/specs/payments-stripe.md §6, withdrawals.md §4, bnb-lane.md §6.
// POST /internal/refunds { actionId, paymentId, amount } (amount in the sale's local currency, SGD), called by the
// agent's executor after a human confirmed. Idempotent on actionId: a replay returns the refund's status, and a
// replay of a `pending` refund resumes it where it stopped.
//
//   validate      payment settled / partially_refunded · 0 < amount ≤ local − refunded · available ≥ amount
//                 (no negative balances) · a card refund rounds to at least 1 cent → else UserFacingError (agent says it)
//   insertRefund  pending (unique action_id)
//   XRPL          settlement.refund: merchant XSGD → treasury, exactly `amount`, at most once per refund
//                 (db.claim guard + xrplTxHash stored) → ledger refund_debit (ref = refundId) right away, so the
//                 ledger keeps matching the XRPL balance even if the Stripe step fails
//   Stripe        refund in the PI's currency: full → the whole charge; partial → charge × amount / local, rounded
//                 down to cents. idempotencyKey "refund:" + actionId. bnb/ausd: no card; returning tokens is manual.
//   finish        db.addPaymentRefund (once) → refund completed → refund.completed (with payer)
//
// XRPL done but Stripe failed → the refund stays pending (xrplTxHash set); retrying the same actionId resumes at the
// Stripe step and never repeats the XRPL transfer. XRPL rejected (nothing moved) → refund failed + refund.failed.
// Unknown XRPL outcome → pending, logged for review (never re-sent automatically).

import {
  cmp,
  format,
  fromMinor,
  isPositive,
  money,
  sub,
  toMinor,
  type Merchant,
  type Money,
  type Payment,
  type Refund,
} from "@rove/shared";
import type { InternalRefundReq, InternalRefundRes } from "./contracts";
import type { WorkerDeps } from "./deps";
import { UserFacingError } from "./errors";
import type { Logger } from "./log";
import { isTokenPayment } from "./settle";
import { serialFor, type Serial } from "./settle/serial";
import { classifyXrplError, errorMessage } from "./settle/xrpl-errors";

const serials = new WeakMap<object, Serial>();

/**
 * What the payer gets back on their card, in minor units of the charge currency (the PI's currency).
 * Full refund → the whole charge. Partial → charge × amount / local, rounded down to the cent. null = no card (tokens).
 */
export function stripeRefundMinor(payment: Pick<Payment, "method" | "local" | "charge">, amount: Money): bigint | null {
  if (isTokenPayment(payment.method)) return null;
  const charge = payment.charge ?? payment.local;
  if (cmp(amount, payment.local) === 0) return toMinor(charge);
  return (toMinor(charge) * toMinor(amount)) / toMinor(payment.local); // bigint division rounds down
}

const res = (r: Pick<Refund, "id" | "status">): InternalRefundRes => ({ refundId: r.id, status: r.status });

export async function handleRefund(deps: WorkerDeps, body: InternalRefundReq): Promise<InternalRefundRes> {
  const existing = await deps.db.getRefundByAction(body.actionId);
  const payment = await deps.db.getPayment(existing?.paymentId ?? body.paymentId);
  if (!payment) throw new UserFacingError("payment_not_found", "I couldn't find that payment.", 404);
  // One refund at a time per merchant: the balance check and the XRPL debit must not interleave.
  return serialFor(serials, deps.db).run(payment.merchantId, () => refundLocked(deps, body));
}

async function refundLocked(deps: WorkerDeps, body: InternalRefundReq): Promise<InternalRefundRes> {
  const log = deps.log.child("refunds");
  const existing = await deps.db.getRefundByAction(body.actionId);
  if (existing) {
    if (existing.status !== "pending") {
      log.info("refund replay", { refundId: existing.id, actionId: body.actionId, status: existing.status });
      return res(existing);
    }
    log.info("resuming pending refund", { refundId: existing.id, actionId: body.actionId, xrplDone: !!existing.xrplTxHash });
    return execute(deps, existing, { resumed: true }, log);
  }

  const payment = await deps.db.getPayment(body.paymentId);
  if (!payment) throw new UserFacingError("payment_not_found", "I couldn't find that payment.", 404);
  const merchant = await deps.db.getMerchant(payment.merchantId);
  const amount = parseAmount(body.amount, payment);
  await validate(deps, payment, merchant, amount);

  const refund = await deps.db.insertRefund({ paymentId: payment.id, merchantId: payment.merchantId, actionId: body.actionId, amount });
  if (refund.status !== "pending") return res(refund);
  log.info("refund started", { refundId: refund.id, actionId: body.actionId, paymentId: payment.id, amount: format(amount) });
  return execute(deps, refund, { resumed: false }, log);
}

// ------------------------------------------------------------------ validation (nothing has moved yet)

function parseAmount(raw: string, payment: Payment): Money {
  let amount: Money;
  try {
    amount = money(raw, payment.local.currency);
  } catch {
    throw new UserFacingError("invalid_amount", `Refunds are in whole cents, like ${format(payment.local)}.`);
  }
  if (!isPositive(amount)) throw new UserFacingError("invalid_amount", "The refund has to be more than zero.");
  return amount;
}

async function validate(deps: WorkerDeps, payment: Payment, merchant: Merchant | null, amount: Money): Promise<void> {
  switch (payment.status) {
    case "settled":
    case "partially_refunded":
      break;
    case "refunded":
      throw new UserFacingError("already_refunded", "That payment was already refunded in full.");
    case "failed":
      throw new UserFacingError("payment_failed", "That payment didn't go through, so there's nothing to refund.");
    default:
      throw new UserFacingError("not_settled", "That payment is still going through. Try the refund again in a minute.");
  }

  const remaining = sub(payment.local, payment.refunded);
  if (cmp(amount, remaining) > 0) {
    throw new UserFacingError(
      "amount_too_large",
      isPositive(payment.refunded)
        ? `Only ${format(remaining)} of that ${format(payment.local)} payment can still be refunded.`
        : `That payment was only ${format(payment.local)}.`,
    );
  }

  if (!merchant?.xrplAddress) throw new Error(`refund: merchant ${payment.merchantId} has no XRPL account`);

  if (!isTokenPayment(payment.method)) {
    if (!payment.stripePaymentIntentId) {
      throw new UserFacingError("not_refundable", "I can't refund that payment automatically: there's no card charge on record for it.");
    }
    if (!deps.stripe) {
      throw new UserFacingError("refunds_unavailable", "Card refunds aren't switched on right now, so nothing was refunded. Try again later.", 503);
    }
    if (stripeRefundMinor(payment, amount)! <= 0n) {
      throw new UserFacingError("amount_too_small", `${format(amount)} is too small to send back to a card. Try a larger amount.`);
    }
  }

  const { available } = await deps.db.getBalance(payment.merchantId);
  if (cmp(available, amount) < 0) {
    throw new UserFacingError(
      "insufficient_funds",
      `Only ${format(available)} is available in your balance right now, so I can't refund ${format(amount)} yet. ` +
        "Once new sales come in, ask me again.",
    );
  }
}

// ------------------------------------------------------------------ execution (resumable)

async function execute(deps: WorkerDeps, refund: Refund, opts: { resumed: boolean }, log: Logger): Promise<InternalRefundRes> {
  const { db } = deps;
  const payment = await db.getPayment(refund.paymentId);
  const merchant = await db.getMerchant(refund.merchantId);
  if (!payment || !merchant?.xrplAddress) {
    log.error("refund pending: its payment or merchant account is missing", { refundId: refund.id, paymentId: refund.paymentId });
    return res(refund);
  }
  const ctx = { refundId: refund.id, actionId: refund.actionId, paymentId: payment.id, merchantId: merchant.id, amount: format(refund.amount) };
  let r = refund;

  // 1. XRPL: merchant XSGD → treasury. At most once per refund, whatever happens to this process.
  if (!r.xrplTxHash) {
    if (opts.resumed) {
      // Nothing moved yet for this refund: re-check, since the balance may have changed since it was requested.
      try {
        await validate(deps, payment, merchant, r.amount);
      } catch (err) {
        return failRefund(deps, r, err instanceof UserFacingError ? err.message : errorMessage(err), log);
      }
    }
    if (!(await db.claim(`refund-xrpl:${r.id}`))) {
      log.error(
        "refund pending: an earlier attempt started the XRPL transfer but recorded no result. Check the merchant's " +
          "account for a Payment to the treasury before doing anything; not re-sending (that could refund twice)",
        ctx,
      );
      return res(r);
    }
    try {
      const { txHash } = await deps.settlement.refund({ paymentId: payment.id, merchantAddress: merchant.xrplAddress, local: r.amount });
      r = (await db.updateRefund(r.id, { xrplTxHash: txHash })) ?? { ...r, xrplTxHash: txHash };
      log.info("refund: XSGD back to treasury", { ...ctx, txHash, explorer: deps.settlement.explorerUrl(txHash) });
    } catch (err) {
      const c = classifyXrplError(err);
      if (c.kind === "ambiguous" || c.kind === "mismatch") {
        log.error("refund pending for review: the XRPL transfer's outcome is unknown (not re-sending)", { ...ctx, error: c.message });
        return res(r);
      }
      log.warn("refund: XRPL transfer rejected; nothing moved", { ...ctx, code: c.code, error: c.message });
      const why = c.code ? ` (${c.code})` : "";
      return failRefund(deps, r, `The money couldn't be moved out of your balance${why}, so nothing was refunded.`, log);
    }
  }

  // 2. Ledger mirrors XRPL immediately (idempotent on (refund_debit, refundId)).
  await db.appendLedger({ merchantId: merchant.id, kind: "refund_debit", amount: r.amount, ref: r.id });

  // 3. The payer.
  if (isTokenPayment(payment.method)) {
    const token = payment.method === "bnb" ? "USDT on BNB Chain" : "AUSD on Base";
    const usd = stripeRefundMinor({ ...payment, method: "card" }, r.amount)!; // same proportional USD math
    const charge = payment.charge ?? payment.local;
    log.warn(`MANUAL STEP: send ${format(fromMinor(usd, charge.currency))} in ${token} back to the payer (bnb-lane.md §6); the XRPL + ledger part is done`, ctx);
  } else if (!r.stripeRefundId) {
    const stripeRefundId = await refundCard(deps, payment, r, log, ctx);
    if (!stripeRefundId) return res(r); // pending: a retry with the same actionId resumes here
    r = (await db.updateRefund(r.id, { stripeRefundId })) ?? { ...r, stripeRefundId };
  }

  // 4. The payment's refunded total, exactly once.
  if (await db.claim(`refund-applied:${r.id}`)) {
    const updated = await db.addPaymentRefund(payment.id, r.amount);
    if (!updated) log.error("refund moved money but couldn't be added to the payment's refunded total: fix by hand", ctx);
  }

  // 5. Done.
  const done = (await db.updateRefund(r.id, { status: "completed" })) ?? { ...r, status: "completed" as const };
  log.info("refund completed", { ...ctx, xrplTxHash: r.xrplTxHash, stripeRefundId: r.stripeRefundId });
  await deps.emit({
    type: "refund.completed",
    refundId: done.id,
    paymentId: payment.id,
    merchantId: merchant.id,
    actionId: done.actionId,
    amount: done.amount,
    payer: payment.payer,
  });
  return res(done);
}

/** Stripe refund in the PI's currency. Returns the Stripe refund id, or null if it didn't go through (stay pending). */
async function refundCard(
  deps: WorkerDeps,
  payment: Payment,
  refund: Refund,
  log: Logger,
  ctx: Record<string, unknown>,
): Promise<string | null> {
  const pi = payment.stripePaymentIntentId;
  const minor = stripeRefundMinor(payment, refund.amount);
  if (!pi || !deps.stripe || minor === null || minor <= 0n) {
    log.error("refund pending: can't refund the card (no PaymentIntent, Stripe not configured, or amount rounds to 0)", { ...ctx, paymentIntent: pi });
    return null;
  }
  const charge = payment.charge ?? payment.local;
  try {
    const sr = await deps.stripe.refunds.create(
      { payment_intent: pi, amount: Number(minor) },
      { idempotencyKey: `refund:${refund.actionId}` },
    );
    if (sr.status === "failed" || sr.status === "canceled") throw new Error(`Stripe refund ${sr.id} is ${sr.status}`);
    log.info("refund: card refunded", { ...ctx, stripeRefundId: sr.id, card: format(fromMinor(minor, charge.currency)), status: sr.status });
    return sr.id;
  } catch (err) {
    log.error("refund pending: Stripe refund failed after the XRPL part was done. Retrying the same action resumes at Stripe", {
      ...ctx,
      paymentIntent: pi,
      err: errorMessage(err),
    });
    return null;
  }
}

async function failRefund(deps: WorkerDeps, refund: Refund, reason: string, log: Logger): Promise<InternalRefundRes> {
  const failed = (await deps.db.updateRefund(refund.id, { status: "failed", failureReason: reason })) ?? { ...refund, status: "failed" as const };
  log.warn("refund failed", { refundId: refund.id, actionId: refund.actionId, paymentId: refund.paymentId, reason });
  await deps.emit({
    type: "refund.failed",
    refundId: refund.id,
    paymentId: refund.paymentId,
    merchantId: refund.merchantId,
    actionId: refund.actionId,
    reason,
  });
  return res(failed);
}
