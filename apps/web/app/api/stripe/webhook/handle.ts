// POST /api/stripe/webhook core. Owner: Nithya · Task: NI-B3 · Spec: docs/specs/payments-stripe.md §2, §7
//
// raw body → constructEvent (400 on a bad signature) → claim("stripe:<event id>") → handle:
//   payment_intent.succeeded       find the payment (metadata.paymentId, else by PI id), Apple Pay vs card from the
//                                  charge's wallet, CAS created → authorized, nudge the worker to settle (it also polls).
//                                  Second payment for an already-paid invoice (payments_one_per_invoice) → full refund,
//                                  payment failed, payment.failed event.
//   payment_intent.payment_failed  log only: the page shows the error and the payment stays `created` for a retry.
//   anything else                  200, ignored.
// 200 for everything handled or ignored so Stripe stops retrying; 500 (via route()) only for unexpected errors.
//
// claim() makes a repeated delivery a no-op, with one exception: a payment_intent.succeeded whose payment is still
// `created`. That means an earlier delivery claimed the event and then crashed before the CAS (Stripe retries after
// our 500); skipping it would leave a charged customer with an open invoice. Every step below is idempotent (status
// CAS, refund idempotency key, event emitted only by the CAS that wins), so running it again is safe.

import type Stripe from "stripe";
import { DbConflictError } from "@rove/db";
import { toMinor, type Payment, type PaymentMethod } from "@rove/shared";
import type { WebDeps } from "../../_lib/deps";
import { HttpError, json } from "../../_lib/http";
import { nudgeWorkerSettle } from "../../_lib/worker";
import { describeStripeError, isStripeError } from "../stripe-errors";

export const DUPLICATE_INVOICE_REASON = "invoice already paid";

export type WebhookOutcome =
  | "authorized"
  | "refunded_duplicate"
  | "already_processed"
  | "duplicate"
  | "unknown_payment"
  | "mismatch"
  | "logged"
  | "ignored";

export interface WebhookOptions {
  /** Ask the worker to settle now. Default: nudgeWorkerSettle with deps.config. */
  nudge?: (paymentId: string) => Promise<unknown>;
}

const log = (msg: string) => console.log(`[api] stripe webhook: ${msg}`);
const warn = (msg: string) => console.warn(`[api] stripe webhook: ${msg}`);

export async function handleStripeWebhook(deps: WebDeps, req: Request, opts: WebhookOptions = {}): Promise<Response> {
  const { stripe, config } = deps;
  // 503 (not 200): Stripe keeps retrying until the deploy has its keys, so no event is lost.
  if (!stripe || !config.stripeWebhookSecret) throw new HttpError(503, "stripe_not_configured", "Stripe isn't configured on this server.");

  const signature = req.headers.get("stripe-signature");
  if (!signature) throw new HttpError(400, "missing_signature", "Missing Stripe-Signature header.");
  const raw = await req.text(); // the exact bytes Stripe signed, never re-serialized JSON
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, config.stripeWebhookSecret);
  } catch (err) {
    warn(`signature check failed: ${describeStripeError(err)}`);
    throw new HttpError(400, "invalid_signature", "Stripe signature verification failed.");
  }

  const first = await deps.db.claim(`stripe:${event.id}`);
  const nudge = opts.nudge ?? ((paymentId: string) => nudgeWorkerSettle(paymentId, { config }));
  let outcome: WebhookOutcome;
  switch (event.type) {
    case "payment_intent.succeeded":
      outcome = await onSucceeded(deps, stripe, event.data.object, first, nudge);
      break;
    case "payment_intent.payment_failed":
      if (first) logFailed(event.data.object);
      outcome = first ? "logged" : "duplicate";
      break;
    default:
      outcome = first ? "ignored" : "duplicate";
  }
  return json({ received: true, outcome });
}

async function onSucceeded(
  deps: WebDeps,
  stripe: Stripe,
  eventPi: Stripe.PaymentIntent,
  first: boolean,
  nudge: (paymentId: string) => Promise<unknown>,
): Promise<WebhookOutcome> {
  const { db } = deps;
  const payment = await findPayment(deps, eventPi);
  if (!payment) {
    warn(`${eventPi.id} succeeded but matches no payment (metadata.paymentId=${eventPi.metadata?.paymentId ?? "none"}); ignored`);
    return "unknown_payment";
  }
  if (payment.status !== "created") return first ? "already_processed" : "duplicate";
  if (!first) log(`redelivered event for ${payment.id}, which is still created: processing it again`);

  if (payment.stripePaymentIntentId && payment.stripePaymentIntentId !== eventPi.id) {
    console.error(`[api] stripe webhook: ${eventPi.id} names ${payment.id}, which belongs to ${payment.stripePaymentIntentId}; not authorizing`);
    return "mismatch";
  }

  const pi = await retrieveWithCharge(stripe, eventPi.id);
  const current = pi ?? eventPi;
  if (payment.charge && (current.currency !== payment.charge.currency.toLowerCase() || current.amount !== Number(toMinor(payment.charge)))) {
    console.error(
      `[api] stripe webhook: ${eventPi.id} charged ${current.amount} ${current.currency} but ${payment.id} expects ` +
        `${payment.charge.amount} ${payment.charge.currency}; not authorizing (needs a human)`,
    );
    return "mismatch";
  }
  const method = methodOf(pi);

  try {
    const updated = await db.transitionPayment(payment.id, ["created"], "authorized", { method });
    if (!updated) return "already_processed"; // a concurrent delivery won the CAS
  } catch (err) {
    if (err instanceof DbConflictError && err.constraint === "payments_one_per_invoice") {
      return refundDuplicate(deps, stripe, payment, eventPi.id, method);
    }
    throw err;
  }
  log(`${payment.id} authorized (${method})`);
  await nudge(payment.id);
  return "authorized";
}

async function findPayment(deps: WebDeps, pi: Stripe.PaymentIntent): Promise<Payment | null> {
  const id = pi.metadata?.paymentId;
  const byId = id ? await deps.db.getPayment(id) : null;
  return byId ?? (await deps.db.getPaymentByStripePI(pi.id));
}

/** The PI with its latest charge expanded (wallet type), or null if Stripe can't be reached: method then falls back to card. */
async function retrieveWithCharge(stripe: Stripe, id: string): Promise<Stripe.PaymentIntent | null> {
  try {
    return await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
  } catch (err) {
    warn(`couldn't retrieve ${id} for the wallet type, recording card: ${describeStripeError(err)}`);
    return null;
  }
}

/** Apple Pay runs through the Express Checkout Element as a card payment; the charge says which wallet paid. */
export function methodOf(pi: Stripe.PaymentIntent | null): PaymentMethod {
  const charge = pi?.latest_charge;
  if (charge && typeof charge === "object" && charge.payment_method_details?.card?.wallet?.type === "apple_pay") return "apple_pay";
  return "card";
}

/**
 * §7: the invoice was already paid by another payment, so this second charge is refunded in full. Refund first, then
 * mark the payment failed: if the refund throws (→ 500), the payment is still `created` and Stripe's retry redoes this
 * (same idempotency key → the same refund). Marking it failed first would strand a charge nobody refunds.
 */
async function refundDuplicate(deps: WebDeps, stripe: Stripe, payment: Payment, piId: string, method: PaymentMethod): Promise<WebhookOutcome> {
  try {
    await stripe.refunds.create({ payment_intent: piId }, { idempotencyKey: `dup:${payment.id}` });
  } catch (err) {
    if (!(isStripeError(err) && err.code === "charge_already_refunded")) throw err;
  }
  const failed = await deps.db.transitionPayment(payment.id, ["created"], "failed", { method, failureReason: DUPLICATE_INVOICE_REASON });
  if (failed) {
    await deps.emit({ type: "payment.failed", paymentId: payment.id, merchantId: payment.merchantId, reason: DUPLICATE_INVOICE_REASON });
  }
  warn(`${payment.id} paid invoice ${payment.invoiceId} a second time; refunded ${piId} in full`);
  return "refunded_duplicate";
}

function logFailed(pi: Stripe.PaymentIntent): void {
  const e = pi.last_payment_error;
  const why = [e?.code, e?.decline_code].filter(Boolean).join("/") || "no reason given";
  log(`${pi.id} (${pi.metadata?.paymentId ?? "no payment id"}) failed: ${why}; the payment stays created`);
}
