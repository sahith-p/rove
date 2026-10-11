// POST /api/checkout: resolve the target, quote, charge the payer in their own currency. Owner: Nithya · Task: NI-B2
// Spec: docs/specs/payments-stripe.md §1, §1a, §7. route.ts wires it; tests call runCheckout() through the route.
//
// The pay page calls checkout on every USD/SGD toggle and again on Pay, so an unexpired `created` payment for the same
// target, currency and method is handed back (same paymentId + clientSecret) instead of minting a new one each time.

import type Stripe from "stripe";
import type { z } from "zod";
import type { Db } from "@rove/db";
import {
  CheckoutRes,
  cmp,
  DECIMALS,
  fromMinor,
  newId,
  toMinor,
  toUnits,
  type Currency,
  type InvoiceLine,
  type Money,
  type Payment,
  type Quote,
} from "@rove/shared";
import type { WebDeps } from "../_lib/deps";
import { HttpError } from "../_lib/http";
import { describeStripeError, isStripeError } from "../stripe/stripe-errors";
import { checkoutAusd } from "./ausd";
import { checkoutBnb } from "./bnb";
import { payerCurrency, resolveTarget, type CheckoutBody, type CheckoutTarget } from "./target";

export type CheckoutResult = z.infer<typeof CheckoutRes>;

/** A reused quote must have at least this long left: the payer still has to tap Pay and get through Apple Pay. */
export const REUSE_MIN_REMAINING_MS = 5_000;
/** How many of the merchant's most recent payments to scan for a reusable one. */
const REUSE_SCAN = 50;
/** Expired-quote PaymentIntents are cancelled (§7) only this long after expiry; older ones were handled by earlier calls. */
const CANCEL_WINDOW_MS = 5 * 60_000;

const PAID: ReadonlySet<Payment["status"]> = new Set(["authorized", "settling", "settled", "partially_refunded", "refunded"]);
/** PaymentIntent states the page can still confirm with the same client secret. */
const CONFIRMABLE: ReadonlySet<Stripe.PaymentIntent.Status> = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
/** The payer already went through with this one; the webhook just hasn't landed. */
const IN_FLIGHT: ReadonlySet<Stripe.PaymentIntent.Status> = new Set(["processing", "requires_capture", "succeeded"]);

export async function runCheckout(deps: WebDeps, body: CheckoutBody, now = Date.now()): Promise<CheckoutResult> {
  const target = await resolveTarget(deps.db, body, now);
  // The stablecoin lanes live in their own modules (always a USD charge); everything below is the Stripe card lane.
  if (body.method === "bnb") return validated(await checkoutBnb(deps, target));
  if (body.method === "ausd") return validated(await checkoutAusd(deps, target));

  const stripe = deps.stripe;
  if (!stripe) throw new HttpError(503, "stripe_not_configured", "Card payments aren't set up yet. Please try again later.");
  const currency = payerCurrency(body, target.payer);

  const reused = await reuseCreated(deps.db, stripe, target, currency, now);
  if (reused) return validated(reused);

  const quote = await deps.settlement.quote({ local: target.local });
  const charge = chargeIn(currency, target.local, quote);
  const paymentId = newId("pay");

  // PaymentIntent first, then one insert that already carries its id: no `created` row ever lacks its PI, and the
  // webhook can't race the insert because the page only gets the client secret after both are done.
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: Number(toMinor(charge)),
        currency: charge.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: { paymentId, merchantId: target.merchantId },
      },
      { idempotencyKey: paymentId },
    );
  } catch (err) {
    throw stripeFailure("create PaymentIntent", err);
  }
  if (!pi.client_secret) throw new Error(`PaymentIntent ${pi.id} came back without a client secret`);

  try {
    await deps.db.insertPayment({
      id: paymentId,
      merchantId: target.merchantId,
      source: target.source,
      invoiceId: target.invoiceId,
      lines: target.lines,
      local: target.local,
      quote,
      charge,
      method: "card", // the webhook records apple_pay vs card once Stripe tells us
      payer: target.payer,
      stripePaymentIntentId: pi.id,
    });
  } catch (err) {
    await cancelQuietly(stripe, [pi.id]);
    throw err;
  }

  return validated({ paymentId, local: target.local, quote, charge, stripe: { clientSecret: pi.client_secret } });
}

/** §1a: SGD payer at an SGD shop → the total itself (no conversion); USD payer → the quote's USD (the swap is inside it). */
function chargeIn(currency: Currency, local: Money, quote: Quote): Money {
  if (currency === local.currency) return local;
  if (currency === quote.usd.currency) {
    // Quotes are in cents already; never undercharge if an engine ever returns more precision.
    return fromMinor(toUnits(quote.usd.amount, DECIMALS.USD, "ceil"), "USD");
  }
  throw new HttpError(400, "currency_not_supported", `Paying in ${currency} isn't supported here.`);
}

/**
 * The newest unexpired `created` card payment for the same target and charge currency, with its PaymentIntent still
 * confirmable → hand it back. Same-target payments whose quote expired get their PaymentIntent cancelled (§7).
 * For an invoice that a payment already got past `created` (or whose PI is mid-payment) → 409 instead of a new charge.
 */
async function reuseCreated(db: Db, stripe: Stripe, target: CheckoutTarget, currency: Currency, now: number): Promise<CheckoutResult | null> {
  const same = (await db.listPayments(target.merchantId, REUSE_SCAN)).filter((p) => sameTarget(p, target)); // newest first
  if (target.invoiceId && same.some((p) => PAID.has(p.status))) throw new HttpError(409, "invoice_paid", "This has already been paid.");

  const stale: string[] = [];
  let found: CheckoutResult | null = null;
  for (const p of same) {
    if (p.status !== "created" || p.method !== "card" || p.charge?.currency !== currency || !p.stripePaymentIntentId || !p.quote) continue;
    const expiresAt = Date.parse(p.quote.expiresAt);
    if (expiresAt <= now) {
      if (now - expiresAt < CANCEL_WINDOW_MS) stale.push(p.stripePaymentIntentId);
      continue;
    }
    if (found || expiresAt - now < REUSE_MIN_REMAINING_MS) continue;

    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId);
    } catch (err) {
      console.warn(`[api] checkout: couldn't retrieve ${p.stripePaymentIntentId} for reuse: ${describeStripeError(err)}`);
      continue;
    }
    if (IN_FLIGHT.has(pi.status)) {
      if (target.invoiceId) throw new HttpError(409, "payment_in_progress", "A payment for this is already going through.");
      continue; // fixed QR: buying the same thing again is a new purchase
    }
    if (!CONFIRMABLE.has(pi.status) || !pi.client_secret) continue;
    if (pi.amount !== Number(toMinor(p.charge)) || pi.currency !== p.charge.currency.toLowerCase()) continue;
    found = { paymentId: p.id, local: p.local, quote: p.quote, charge: p.charge, stripe: { clientSecret: pi.client_secret } };
  }
  await cancelQuietly(stripe, stale);
  return found;
}

function sameTarget(p: Payment, t: CheckoutTarget): boolean {
  if (t.invoiceId) return p.invoiceId === t.invoiceId;
  return (
    p.source === "fixed_qr" &&
    p.invoiceId === null &&
    p.local.currency === t.local.currency &&
    cmp(p.local, t.local) === 0 &&
    linesKey(p.lines) === linesKey(t.lines) &&
    (p.payer?.phone ?? null) === (t.payer?.phone ?? null)
  );
}

/** Order-insensitive identity of a basket: item, name, qty and unit price in minor units. */
function linesKey(lines: InvoiceLine[]): string {
  return JSON.stringify(
    lines.map((l) => [l.menuItemId ?? "", l.name, l.qty, l.unit.currency, toMinor(l.unit).toString()].join("|")).sort(),
  );
}

/** Best effort: an unconfirmed PaymentIntent left open is harmless, so failures are only logged. */
async function cancelQuietly(stripe: Stripe, ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await stripe.paymentIntents.cancel(id);
      } catch (err) {
        console.warn(`[api] checkout: couldn't cancel ${id}: ${describeStripeError(err)}`);
      }
    }),
  );
}

function stripeFailure(what: string, err: unknown): unknown {
  if (!isStripeError(err)) return err;
  console.error(`[api] checkout: Stripe ${what} failed: ${describeStripeError(err)}`);
  if (err.code === "amount_too_small") return new HttpError(400, "amount_too_small", "That amount is too small to pay by card.");
  return new HttpError(502, "stripe_error", "Couldn't start the card payment. Please try again.");
}

/** Validate what we send against the contract. A mismatch is our bug: 500, not a 400 for the caller. */
function validated(res: CheckoutResult): CheckoutResult {
  const parsed = CheckoutRes.safeParse(res);
  if (!parsed.success) throw new Error(`checkout response failed CheckoutRes: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}
