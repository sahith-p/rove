"use client";
// /pay/[code] state machine: loading → open → (checkout) → processing (poll) → paid, plus closed / not found / failed.
// Amounts only ever come from the API (or fixtures in demo mode), never from the URL.
// The payer is charged in their own currency (`charge`, payments-stripe.md §1a): SGD total until checkout quotes it.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PAYMENT_CODE_RE, type Currency, type Money, type PaymentStatus } from "@rove/shared";
import { ArrowUpRight, Check, CircleAlert, Clock, Receipt, RotateCw, SearchX, X } from "lucide-react";
import {
  Amount,
  Button,
  Card,
  CodeCells,
  IconBadge,
  LineItems,
  MerchantHeader,
  PageFooter,
  StateBlock,
  StatusStepper,
  type Step,
} from "../../../components";
import type { CryptoHandlers, CryptoMethod } from "../../../components/privy/lazy";
import { ExpressPay, clearStripeReturn, readStripeReturn, toIntent, type StripeIntent } from "../../../components/stripe/ExpressPay";
import { format, shortHash } from "../../../lib/ui/format";
import { contractMethod, getInvoice, getPayment, startCheckout, type PayMethod } from "./_api";
import {
  FIXTURES_ENABLED,
  fixtureCheckout,
  fixtureInvoice,
  fixturePayment,
  simulatedStatus,
  type CheckoutView,
  type InvoiceKind,
  type InvoiceView,
  type PaymentView,
  type PreviewState,
} from "./_fixtures";
import { CurrencyToggle, localeCurrency } from "./CurrencyToggle";
import { PayOptions } from "./PayOptions";
import styles from "./pay.module.css";

type ClosedReason = "expired" | "already_paid" | "cancelled";

type Phase =
  | { name: "loading" }
  | { name: "open"; invoice: InvoiceView }
  | { name: "processing"; invoice: InvoiceView; checkout: CheckoutView | null; paymentId: string; payment: PaymentView | null }
  | { name: "paid"; invoice: InvoiceView; checkout: CheckoutView | null; payment: PaymentView }
  | { name: "failed"; invoice: InvoiceView }
  | { name: "closed"; invoice: InvoiceView; reason: ClosedReason }
  | { name: "not_found" }
  | { name: "error" };

/** A checkout result held on the open page (from the currency toggle), reused by the card / Apple Pay buttons. */
interface Held {
  checkout: CheckoutView;
  currency: Currency;
  method: "card" | "bnb";
  simulated: boolean;
}

/** A live card checkout waiting for the payer in Stripe's sheet (Apple Pay / Google Pay / Link / card form). */
type Intent = StripeIntent<CheckoutView>;

/** A fixture-mode settlement simulation in progress. */
interface Sim {
  start: number;
  method: PayMethod;
  charge: Money | undefined;
}

const POLL_MS = 1000;
const SIM_POLL_MS = 500;
const SETTLED: PaymentStatus[] = ["settled", "partially_refunded", "refunded"];

function phaseForInvoice(invoice: InvoiceView, now = Date.now()): Phase {
  if (invoice.status === "paid") return { name: "closed", invoice, reason: "already_paid" };
  if (invoice.status === "cancelled") return { name: "closed", invoice, reason: "cancelled" };
  if (invoice.status === "expired" || Date.parse(invoice.expiresAt) <= now) return { name: "closed", invoice, reason: "expired" };
  return { name: "open", invoice };
}

function previewPhase(code: string, state: PreviewState, kind: InvoiceKind): Phase {
  const invoice = fixtureInvoice(code, kind);
  const checkout = fixtureCheckout(invoice, "USD", "card");
  const processing = (status: PaymentStatus): Phase => ({
    name: "processing",
    invoice,
    checkout,
    paymentId: checkout.paymentId,
    payment: fixturePayment(status),
  });
  switch (state) {
    case "loading":
      return { name: "loading" };
    case "open":
      return { name: "open", invoice };
    case "paying":
      return processing("created");
    case "settling":
      return processing("settling");
    case "paid":
      return { name: "paid", invoice, checkout, payment: fixturePayment("settled") };
    case "failed":
      return { name: "failed", invoice };
    case "expired":
      return phaseForInvoice(fixtureInvoice(code, kind, "expired"));
    case "already_paid":
      return phaseForInvoice(fixtureInvoice(code, kind, "paid"));
    case "cancelled":
      return phaseForInvoice(fixtureInvoice(code, kind, "cancelled"));
    case "not_found":
      return { name: "not_found" };
    case "error":
      return { name: "error" };
  }
}

/** "Expires in 24 min" · "Expires in 3 hr" · "Expires 18 Oct". */
function expiryHint(iso: string, now: number): string | null {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms) || ms <= 0) return null;
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `Expires in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `Expires in ${hr} hr`;
  const date = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", timeZone: "Asia/Singapore" }).format(Date.parse(iso));
  return `Expires ${date}`;
}

/** What "Payment received" waits on, by lane. */
function waitingDetail(checkout: CheckoutView | null, payment: PaymentView | null): string {
  const method = payment?.method ?? (checkout?.bnb ? "bnb" : checkout?.ausd ? "ausd" : "card");
  if (method === "bnb") return "Waiting for BNB Chain confirmations…";
  if (method === "ausd") return "Relaying your AUSD on Base…";
  return "Confirming with your bank…";
}

function steps(status: PaymentStatus | undefined, payment: PaymentView | null, checkout: CheckoutView | null = null): Step[] {
  const s = status ?? "created";
  if (s === "failed") {
    return [
      { label: "Payment received", state: "failed", detail: "You weren't charged" },
      { label: "Settling on XRPL", state: "todo" },
      { label: "Paid", state: "todo" },
    ];
  }
  const settled = SETTLED.includes(s);
  const received = s !== "created";
  return [
    { label: "Payment received", state: received ? "done" : "current", detail: received ? undefined : waitingDetail(checkout, payment) },
    {
      label: "Settling on XRPL",
      state: settled ? "done" : received ? "current" : "todo",
      detail: payment?.settleTxHash ? shortHash(payment.settleTxHash, 6) : received && !settled ? "A few seconds" : undefined,
      href: payment?.explorerUrl,
    },
    { label: "Paid", state: settled ? "done" : "todo" },
  ];
}

/**
 * The big amount. Before checkout: the invoice total (SGD). After: `charge` in the payer's currency, with
 * "S$12.50 to Ah Seng · rate 1.2860 · no card FX fees" under it.
 */
function ChargeAmount({
  invoice,
  checkout,
  payment,
  label,
}: {
  invoice: InvoiceView;
  checkout: CheckoutView | null;
  payment?: PaymentView | null;
  label?: string;
}) {
  const charge = payment?.charge ?? checkout?.charge;
  if (!charge) return <Amount money={payment?.local ?? invoice.total} label={label} />;
  const local = payment?.local ?? checkout?.local ?? invoice.total;
  const merchant = payment?.merchantName || invoice.merchant.name;
  const converted = charge.currency !== local.currency;
  const sub = converted
    ? `${format(local)} to ${merchant}${checkout ? ` · rate ${checkout.quote.rate}` : ""} · no card FX fees`
    : `To ${merchant} · no conversion · no card FX fees`;
  return <Amount money={charge} sub={sub} label={label} />;
}

export interface PayClientProps {
  code: string;
  /** Fixture mode only: render this state without calling the APIs. */
  preview: PreviewState | null;
  /** Fixture mode only: invoice kind for fixture data. */
  fixtureKind: InvoiceKind;
}

export function PayClient({ code, preview, fixtureKind }: PayClientProps) {
  const [phase, setPhase] = useState<Phase>(() => (preview ? previewPhase(code, preview, fixtureKind) : { name: "loading" }));
  const [busy, setBusy] = useState<PayMethod | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [usingFixtures, setUsingFixtures] = useState(preview !== null);
  const [now, setNow] = useState(() => Date.now());
  /** null until mounted (locale is a browser thing), then the locale guess or the payer's toggle. */
  const [payCurrency, setPayCurrency] = useState<Currency | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const sim = useRef<Sim | null>(null);
  /** Back from a Stripe redirect (3DS): resume polling that payment once the invoice has loaded. Read once. */
  const stripeReturn = useRef<ReturnType<typeof readStripeReturn> | undefined>(undefined);

  useEffect(() => setPayCurrency(localeCurrency()), []);

  const load = useCallback(async () => {
    if (!PAYMENT_CODE_RE.test(code)) return setPhase({ name: "not_found" });
    setPhase({ name: "loading" });
    if (stripeReturn.current === undefined) {
      stripeReturn.current = readStripeReturn();
      if (stripeReturn.current) clearStripeReturn();
    }
    const back = stripeReturn.current; // kept (not consumed) so a double-run effect resumes too; Try again clears it
    const res = await getInvoice(code);
    if (res.ok && back && back.status !== "failed") {
      return setPhase({ name: "processing", invoice: res.data, checkout: null, paymentId: back.paymentId, payment: null });
    }
    if (res.ok && back) setCheckoutError("Your payment didn't go through. Try again or use another method.");
    if (res.ok) return setPhase(phaseForInvoice(res.data));
    if (res.status === 404) return setPhase({ name: "not_found" });
    if (FIXTURES_ENABLED) {
      setUsingFixtures(true);
      return setPhase(phaseForInvoice(fixtureInvoice(code, fixtureKind)));
    }
    setPhase({ name: "error" });
  }, [code, fixtureKind]);

  useEffect(() => {
    if (!preview) void load();
  }, [preview, load]);

  // Tick the expiry hint, and close the page when an open code runs out.
  const openInvoice = phase.name === "open" ? phase.invoice : null;
  useEffect(() => {
    if (!openInvoice) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (Date.parse(openInvoice.expiresAt) <= t) setPhase({ name: "closed", invoice: openInvoice, reason: "expired" });
    }, 15_000);
    return () => clearInterval(id);
  }, [openInvoice]);

  // Poll the payment until it settles or fails. Previews stay frozen.
  const processingId = phase.name === "processing" ? phase.paymentId : null;
  const processingCharge = phase.name === "processing" ? phase.checkout?.charge : undefined;
  useEffect(() => {
    if (!processingId) return;
    // A ?state=paying / settling preview stays frozen; a preview that was paid from ?state=open runs the simulation.
    if (preview && sim.current === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let payment: PaymentView | null = null;
      const s = sim.current;
      if (s) {
        payment = fixturePayment(simulatedStatus(s.start), s.method, s.charge);
      } else {
        const res = await getPayment(processingId);
        if (res.ok) payment = res.data;
        else if (FIXTURES_ENABLED && (res.status === 501 || res.status === 404)) {
          setUsingFixtures(true);
          sim.current = { start: Date.now(), method: "card", charge: processingCharge };
        }
      }
      if (stopped) return;
      if (payment) {
        const p = payment;
        setPhase((prev) => {
          if (prev.name !== "processing") return prev;
          if (SETTLED.includes(p.status)) return { name: "paid", invoice: prev.invoice, checkout: prev.checkout, payment: p };
          if (p.status === "failed") return { name: "failed", invoice: prev.invoice };
          return { ...prev, payment: p };
        });
        if (SETTLED.includes(p.status) || p.status === "failed") return;
      }
      timer = setTimeout(tick, sim.current ? SIM_POLL_MS : POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [processingId, processingCharge, preview]);

  /** POST /api/checkout (or a fixture). `null` = failed; the error is already shown. */
  const checkout = useCallback(
    async (invoice: InvoiceView, method: PayMethod, currency: Currency): Promise<{ data: CheckoutView; simulated: boolean } | null> => {
      if (preview) return { data: fixtureCheckout(invoice, currency, contractMethod(method)), simulated: true };
      const res = await startCheckout(invoice.code, method, currency);
      if (res.ok) return { data: res.data, simulated: false };
      if (FIXTURES_ENABLED && (res.status === 501 || res.status === null)) {
        setUsingFixtures(true);
        return { data: fixtureCheckout(invoice, currency, contractMethod(method)), simulated: true };
      }
      setCheckoutError(
        res.status === 409 || res.status === 410 ? "This code can't be paid any more. Reload to check its status." : "Couldn't start the payment. Please try again.",
      );
      return null;
    },
    [preview],
  );

  // Currency toggle: re-quote with checkout so the big amount shows exactly what will be charged.
  const onCurrency = useCallback(
    async (currency: Currency) => {
      setPayCurrency(currency);
      if (phase.name !== "open" || busy) return;
      setQuoting(true);
      setCheckoutError(null);
      const res = await checkout(phase.invoice, "card", currency);
      setQuoting(false);
      setHeld(res ? { checkout: res.data, currency, method: "card", simulated: res.simulated } : null);
      // Stripe's sheet is open: swap it to the new currency's PaymentIntent (or close it if that failed).
      setIntent((prev) => (prev ? toIntent(res, currency, prev.preferCard) : null));
    },
    [phase, busy, checkout],
  );

  const onPay = useCallback(
    async (method: PayMethod) => {
      if (phase.name !== "open" || busy || quoting) return;
      const invoice = phase.invoice;
      const currency = payCurrency ?? "USD";
      setBusy(method);
      setCheckoutError(null);

      const reusable =
        held && held.method === contractMethod(method) && held.currency === currency && Date.parse(held.checkout.quote.expiresAt) > Date.now();
      const res = reusable ? { data: held.checkout, simulated: held.simulated } : await checkout(invoice, method, currency);
      if (!res) return setBusy(null);

      if (res.simulated) {
        sim.current = { start: Date.now(), method, charge: res.data.charge };
        await new Promise((r) => setTimeout(r, 600));
      } else if (contractMethod(method) === "card") {
        // Live card checkout: stay on this page with Stripe's sheet; ExpressPay → onStripePaid moves to processing.
        sim.current = null;
        setBusy(null);
        setHeld(null);
        const next = toIntent(res, currency, method === "card");
        if (!next) return setCheckoutError("Couldn't start the card payment. Please try again.");
        return setIntent(next);
      } else {
        // Crypto methods go through PayOptions' `crypto` handlers (components/privy), not onPay.
        sim.current = null;
      }
      setBusy(null);
      setHeld(null);
      setPhase({
        name: "processing",
        invoice,
        checkout: res.data,
        paymentId: res.data.paymentId,
        payment: res.simulated ? fixturePayment("created", method, res.data.charge) : null,
      });
    },
    [phase, busy, quoting, payCurrency, held, checkout],
  );

  /** Crypto lanes (SH-A4): the buttons in components/privy run the wallet steps; the page owns checkout and polling. */
  const crypto = useMemo<CryptoHandlers>(
    () => ({
      start: async (method: CryptoMethod) => {
        if (phase.name !== "open") return null;
        const invoice = phase.invoice;
        setCheckoutError(null);
        const res = await checkout(invoice, method, "USD");
        if (!res) return null;
        if (!res.simulated) return res.data;
        // Demo mode (no backend): no wallet step, just run the simulated settlement.
        sim.current = { start: Date.now(), method, charge: res.data.charge };
        setPhase({ name: "processing", invoice, checkout: res.data, paymentId: res.data.paymentId, payment: fixturePayment("created", method, res.data.charge) });
        return null;
      },
      submitted: (c: CheckoutView) => {
        sim.current = null;
        setHeld(null);
        setPhase((prev) => (prev.name === "open" ? { name: "processing", invoice: prev.invoice, checkout: c, paymentId: c.paymentId, payment: null } : prev));
      },
    }),
    [phase, checkout],
  );

  /** Stripe confirmed the PaymentIntent: poll our payment through the webhook (authorized) and settlement (settled). */
  const onStripePaid = useCallback(() => {
    if (phase.name !== "open" || !intent) return;
    sim.current = null;
    setPhase({ name: "processing", invoice: phase.invoice, checkout: intent.checkout, paymentId: intent.checkout.paymentId, payment: null });
    setIntent(null);
  }, [phase, intent]);

  return (
    <main className={styles.page}>
      <Body
        phase={phase}
        code={code}
        now={now}
        busy={busy}
        checkoutError={checkoutError}
        held={intent ? intent.checkout : held && held.currency === payCurrency ? held.checkout : null}
        intent={intent}
        onStripePaid={onStripePaid}
        onStripeCancel={() => setIntent(null)}
        crypto={crypto}
        payCurrency={payCurrency}
        quoting={quoting}
        onCurrency={onCurrency}
        onPay={onPay}
        onRetry={() => {
          setHeld(null);
          setIntent(null);
          stripeReturn.current = null;
          if (preview) setPhase(previewPhase(code, "open", fixtureKind));
          else void load();
        }}
      />
      <PageFooter demo={usingFixtures} className={styles.footer}>
        Settles on XRPL
      </PageFooter>
    </main>
  );
}

interface BodyProps {
  phase: Phase;
  code: string;
  now: number;
  busy: PayMethod | null;
  checkoutError: string | null;
  held: CheckoutView | null;
  payCurrency: Currency | null;
  quoting: boolean;
  onCurrency: (c: Currency) => void;
  onPay: (m: PayMethod) => void;
  onRetry: () => void;
  intent: Intent | null;
  onStripePaid: () => void;
  onStripeCancel: () => void;
  crypto: CryptoHandlers;
}

function Body(props: BodyProps) {
  const { phase, code, now, busy, checkoutError, held, payCurrency, quoting, onCurrency, onPay, onRetry, intent, onStripePaid, onStripeCancel, crypto } = props;
  switch (phase.name) {
    case "loading":
      return (
        <div className={styles.loading} aria-busy="true">
          <div className={styles.skRow}>
            <div className={`${styles.skeleton} ${styles.skName}`} />
          </div>
          <div className={`${styles.skeleton} ${styles.skAmount}`} />
          <CodeCells code={code.length === 6 ? code : "······"} />
          <div className={`${styles.skeleton} ${styles.skCard}`} />
          <span className="sr-only">Loading payment…</span>
        </div>
      );

    case "open": {
      const { invoice } = phase;
      const hint = expiryHint(invoice.expiresAt, now);
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <section className={styles.hero} aria-busy={quoting || undefined}>
            <ChargeAmount invoice={invoice} checkout={held} label="Amount due" />
            {payCurrency ? <CurrencyToggle value={payCurrency} onChange={onCurrency} disabled={busy !== null || quoting} busy={quoting} /> : null}
          </section>
          <section className={styles.codeBlock} aria-label="Payment code">
            <div className={styles.codeHead}>
              <span className="eyebrow">Payment code</span>
              {hint ? (
                <span className={styles.expiry} suppressHydrationWarning>
                  <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                  {hint}
                </span>
              ) : null}
            </div>
            <CodeCells code={invoice.code} />
          </section>
          {invoice.lines.length > 0 || invoice.note ? (
            <Card label="Order">
              {invoice.lines.length > 0 ? <LineItems lines={invoice.lines} total={invoice.total} /> : null}
              {invoice.note ? (
                <p className={styles.note}>
                  <span className="eyebrow">Note</span>
                  {invoice.note}
                </p>
              ) : null}
            </Card>
          ) : null}
          {checkoutError ? (
            <p className={styles.inlineError} role="alert">
              <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              {checkoutError}
            </p>
          ) : null}
          <div className={styles.payBlock}>
            {intent ? (
              quoting ? null : <ExpressPay key={intent.checkout.stripe.clientSecret} intent={intent} onPaid={onStripePaid} onCancel={onStripeCancel} />
            ) : (
              <PayOptions onPay={onPay} busy={busy} disabled={quoting} crypto={crypto} />
            )}
          </div>
        </>
      );
    }

    case "processing": {
      const { invoice, checkout, payment } = phase;
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <section className={styles.hero}>
            <ChargeAmount invoice={invoice} checkout={checkout} payment={payment} label="Paying" />
          </section>
          <Card label="Status">
            <p className={styles.statusLine} aria-live="polite">
              {payment && payment.status !== "created" ? "Payment received. Settling…" : "Processing your payment…"}
            </p>
            <StatusStepper steps={steps(payment?.status, payment, checkout)} />
          </Card>
          <p className={styles.hintCenter}>You can keep this open. It updates by itself.</p>
        </>
      );
    }

    case "paid": {
      const { invoice, checkout, payment } = phase;
      return (
        <>
          <section className={styles.paidHero}>
            <IconBadge tone="success" size="lg">
              <Check size={30} strokeWidth={2.25} />
            </IconBadge>
            <h1 className={`twoTone ${styles.paidTitle}`}>
              <span>Paid</span>
              <span>{payment.merchantName || invoice.merchant.name}</span>
            </h1>
          </section>
          <ChargeAmount invoice={invoice} checkout={checkout} payment={payment} />
          <Card label="Status">
            <StatusStepper steps={steps(payment.status, payment)} />
          </Card>
          <div className={styles.actions}>
            <Button fullWidth href={`/r/${encodeURIComponent(payment.paymentId)}`} icon={<Receipt size={18} strokeWidth={1.75} />}>
              Receipt
            </Button>
            {payment.explorerUrl ? (
              <Button
                fullWidth
                variant="secondary"
                href={payment.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                trailingIcon={<ArrowUpRight size={16} strokeWidth={1.75} />}
              >
                View on XRPL
              </Button>
            ) : null}
          </div>
        </>
      );
    }

    case "failed":
      return (
        <>
          <MerchantHeader name={phase.invoice.merchant.name} verified={phase.invoice.merchant.verified} />
          <StateBlock
            tone="error"
            icon={<X size={22} strokeWidth={1.75} />}
            title="Payment failed"
            line="You weren't charged. Try again or use another method."
            facts={[["Code", code, true]]}
          />
          <Button fullWidth onClick={onRetry} icon={<RotateCw size={18} strokeWidth={1.75} />}>
            Try again
          </Button>
        </>
      );

    case "closed": {
      const { invoice, reason } = phase;
      const what = invoice.kind === "invoice" ? "invoice" : "code";
      const copy: Record<ClosedReason, { title: string; line: string; tone: "muted" | "success"; icon: ReactNode }> = {
        expired: {
          title: "This code has expired",
          line: `Ask ${invoice.merchant.name} for a new one.`,
          tone: "muted",
          icon: <Clock size={22} strokeWidth={1.5} />,
        },
        already_paid: {
          title: "Already paid",
          line: `This ${what} has been paid. Nothing more to do.`,
          tone: "success",
          icon: <Check size={24} strokeWidth={2.25} />,
        },
        cancelled: {
          title: "Cancelled",
          line: `${invoice.merchant.name} cancelled this ${what}.`,
          tone: "muted",
          icon: <X size={22} strokeWidth={1.5} />,
        },
      };
      const c = copy[reason];
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <StateBlock
            tone={c.tone}
            icon={c.icon}
            title={c.title}
            line={c.line}
            facts={[
              ["Amount", format(invoice.total)],
              ["Code", invoice.code, true],
            ]}
          />
        </>
      );
    }

    case "not_found":
      return (
        <StateBlock
          tone="muted"
          icon={<SearchX size={22} strokeWidth={1.5} />}
          title="Code not found"
          line="Check the code, or ask the shop for a new one."
          facts={[["Code", code, true]]}
        />
      );

    case "error":
      return (
        <>
          <StateBlock
            tone="error"
            icon={<CircleAlert size={22} strokeWidth={1.5} />}
            title="Couldn't load this payment"
            line="Check your connection and try again."
            facts={[["Code", code, true]]}
          />
          <Button fullWidth variant="secondary" onClick={onRetry} icon={<RotateCw size={18} strokeWidth={1.75} />}>
            Try again
          </Button>
        </>
      );
  }
}

