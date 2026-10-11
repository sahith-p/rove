"use client";
// Stripe Express Checkout (Apple Pay / Google Pay / Link) with a compact "Pay with card" fallback, for one PaymentIntent.
// Task: SH-A3 · Spec: docs/specs/payments-stripe.md §1, §1a, §3.
// The PaymentIntent (and so the amount on the Apple Pay sheet) comes from POST /api/checkout; `charge` is only shown.
// Confirm → `onPaid(paymentIntentId)`; the page then polls GET /api/payments/:id until the webhook + worker settle it.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { loadStripe, type Appearance, type Stripe, type StripeElementsOptions } from "@stripe/stripe-js";
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Currency, Money } from "@rove/shared";
import { ChevronRight, CircleAlert, CreditCard, Lock } from "lucide-react";
import { Button } from "../Button";
import { format } from "../../lib/ui/format";
import styles from "./ExpressPay.module.css";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

/** One Stripe.js load per page (loadStripe injects the script; calling it twice would load it twice). */
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (!PUBLISHABLE_KEY) return null;
  stripePromise ??= loadStripe(PUBLISHABLE_KEY);
  return stripePromise;
}

/** Query params Stripe appends to return_url after a redirect (3DS, some wallets). */
export const STRIPE_RETURN_PARAMS = ["payment_intent", "payment_intent_client_secret", "redirect_status"] as const;
/** Our own param on return_url, so the page can resume polling the right payment after a redirect. */
export const RETURN_PAYMENT_PARAM = "rove_payment";

/** What a page needs to resume after a Stripe redirect, or null when this load isn't one. Read once on mount. */
export function readStripeReturn(): { paymentId: string; status: string } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const paymentId = q.get(RETURN_PAYMENT_PARAM);
  const status = q.get("redirect_status");
  if (!paymentId || !status) return null;
  return { paymentId, status };
}

/** Drop the Stripe + resume params from the address bar (so a reload doesn't resume again). */
export function clearStripeReturn(): void {
  const url = new URL(window.location.href);
  for (const k of [...STRIPE_RETURN_PARAMS, RETURN_PAYMENT_PARAM]) url.searchParams.delete(k);
  window.history.replaceState(window.history.state, "", url.toString());
}

function returnUrl(paymentId: string): string {
  const url = new URL(window.location.href);
  for (const k of STRIPE_RETURN_PARAMS) url.searchParams.delete(k);
  url.searchParams.set(RETURN_PAYMENT_PARAM, paymentId);
  return url.toString();
}

/**
 * Monochrome to match the pages: the globals.css tokens as literals (Stripe's iframe can't read CSS variables).
 * Pure neutral grays (R=G=B), one hairline border color, ink focus, Geist (loaded into the iframe via `fonts`).
 */
function appearance(dark: boolean): Appearance {
  const ink = dark ? "#fafafa" : "#0a0a0a";
  const line = dark ? "#262626" : "#e5e5e5";
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: ink,
      colorBackground: dark ? "#0a0a0a" : "#ffffff",
      colorText: ink,
      colorTextSecondary: dark ? "#a3a3a3" : "#737373",
      colorTextPlaceholder: dark ? "#737373" : "#a3a3a3",
      colorDanger: dark ? "#f87171" : "#dc2626",
      colorIcon: dark ? "#a3a3a3" : "#737373",
      fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSizeBase: "16px",
      borderRadius: "14px",
      spacingUnit: "4px",
    },
    rules: {
      ".Input": { border: `1px solid ${line}`, boxShadow: "none" },
      ".Input:focus": { border: `1px solid ${ink}`, boxShadow: `0 0 0 1px ${ink}` },
      ".Tab": { border: `1px solid ${line}`, boxShadow: "none" },
      ".Tab--selected": { border: `1px solid ${ink}`, boxShadow: `0 0 0 1px ${ink}` },
      ".Label": { fontWeight: "500" },
    },
  };
}

/** Geist inside Stripe's iframe (it can't see next/font). */
const STRIPE_FONTS = [{ cssSrc: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" }];

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    setDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return dark;
}

/** The parts of a CheckoutRes this component needs. */
interface CardCheckout {
  paymentId: string;
  local: Money;
  charge?: Money;
  stripe?: { clientSecret: string };
}

/** A live card checkout waiting for the payer in Stripe's sheet. */
export interface StripeIntent<C extends CardCheckout = CardCheckout> {
  checkout: C & { stripe: { clientSecret: string } };
  currency: Currency;
  /** Open the card form first (the payer picked "card" rather than Apple Pay). */
  preferCard: boolean;
}

/** A real (not simulated) card checkout result → the sheet's intent; null when it has no client secret. */
export function toIntent<C extends CardCheckout>(
  res: { data: C; simulated: boolean } | null,
  currency: Currency,
  preferCard: boolean,
): StripeIntent<C> | null {
  if (!res || res.simulated || !res.data.stripe) return null;
  return { checkout: { ...res.data, stripe: res.data.stripe }, currency, preferCard };
}

export interface ExpressPayProps {
  /** From POST /api/checkout. A new client secret needs a remount: render with `key={intent.checkout.stripe.clientSecret}`. */
  intent: StripeIntent;
  /** The PaymentIntent went through (succeeded / processing). Start polling the payment. */
  onPaid: (paymentIntentId: string) => void;
  /** Leave the Stripe sheet (pick another method). */
  onCancel?: () => void;
}

export function ExpressPay(props: ExpressPayProps) {
  const dark = usePrefersDark();
  const stripe = useMemo(() => getStripe(), []);
  const clientSecret = props.intent.checkout.stripe.clientSecret;
  const options = useMemo<StripeElementsOptions>(() => ({ clientSecret, appearance: appearance(dark), fonts: STRIPE_FONTS }), [clientSecret, dark]);

  if (!stripe) {
    return (
      <p className={styles.error} role="alert">
        Card payments aren&apos;t set up on this page yet.
      </p>
    );
  }
  return (
    <Elements stripe={stripe} options={options}>
      <ExpressPayInner {...props} />
    </Elements>
  );
}

type ExpressState = "loading" | "ready" | "none";
const EXPRESS_READY_TIMEOUT_MS = 5000;

function ExpressPayInner({ intent, onPaid, onCancel }: ExpressPayProps) {
  const { paymentId } = intent.checkout;
  // CheckoutRes.charge is what the PaymentIntent charges, in the payer's currency (display only; Stripe has the amount).
  const charge = intent.checkout.charge ?? intent.checkout.local;
  const stripe = useStripe();
  const elements = useElements();
  const [express, setExpress] = useState<ExpressState>("loading");
  const [cardOpen, setCardOpen] = useState(intent.preferCard);
  const [cardComplete, setCardComplete] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Some web views never report the Express Checkout Element ready: don't leave an empty slot, open the card form.
  // (If it does become ready later, onReady shows it again.)
  useEffect(() => {
    const id = setTimeout(() => setExpress((s) => (s === "loading" ? "none" : s)), EXPRESS_READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  /** Shared by both buttons. `null` = it went through; otherwise the message to show. */
  const confirm = async (): Promise<string | null> => {
    if (!stripe || !elements) return "Still loading. Try again in a moment.";
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl(paymentId) },
      redirect: "if_required",
    });
    if (err) return err.message ?? "Your payment didn't go through. Try another card.";
    if (paymentIntent && ["succeeded", "processing", "requires_capture"].includes(paymentIntent.status)) {
      onPaid(paymentIntent.id);
      return null;
    }
    return "Your payment didn't go through. Try another card.";
  };

  const onCardSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (paying) return;
    setPaying(true);
    setError(null);
    const msg = await confirm();
    if (msg) {
      setError(msg);
      setPaying(false);
    }
  };

  const amount = format(charge);
  const showCard = cardOpen || express === "none";

  return (
    <div className={styles.root}>
      <div className={express === "none" ? styles.hidden : styles.express} aria-busy={express === "loading" || undefined}>
        <ExpressCheckoutElement
          options={{
            buttonHeight: 52,
            buttonType: { applePay: "plain", googlePay: "plain" },
            buttonTheme: { applePay: "black", googlePay: "black" },
            layout: { maxColumns: 1, maxRows: 3, overflow: "never" },
          }}
          onReady={(e) => setExpress(e.availablePaymentMethods ? "ready" : "none")}
          onLoadError={() => setExpress("none")}
          onClick={(e) => {
            setError(null);
            e.resolve();
          }}
          onConfirm={async (e) => {
            setPaying(true);
            const msg = await confirm();
            if (msg) {
              e.paymentFailed({ reason: "fail" });
              setError(msg);
              setPaying(false);
            }
          }}
        />
      </div>

      {express !== "none" ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={showCard}
          aria-controls="rove-card-form"
          onClick={() => {
            setCardComplete(false);
            setCardOpen((o) => !o);
          }}
          disabled={paying}
        >
          <span className={styles.toggleLabel}>
            <CreditCard size={18} strokeWidth={1.5} aria-hidden="true" />
            Pay with card
          </span>
          <ChevronRight size={18} strokeWidth={1.5} aria-hidden="true" className={showCard ? styles.chevOpen : styles.chev} />
        </button>
      ) : null}

      {/* Mounted only while open: a Payment Element mounted inside display:none measures 0px tall and stays that way. */}
      {showCard ? (
        <form id="rove-card-form" className={styles.card} onSubmit={onCardSubmit} noValidate>
          <PaymentElement
            options={{
              layout: "tabs",
              paymentMethodOrder: ["card"],
              wallets: { applePay: "never", googlePay: "never" },
            }}
            onChange={(e) => setCardComplete(e.complete)}
          />
          <Button
            type="submit"
            fullWidth
            loading={paying}
            disabled={!stripe || !elements || !cardComplete || paying}
            icon={<Lock size={17} strokeWidth={1.5} />}
          >
            {paying ? "Paying…" : `Pay ${amount}`}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {onCancel ? (
        <button type="button" className={styles.back} onClick={onCancel} disabled={paying}>
          Use another method
        </button>
      ) : null}
    </div>
  );
}
