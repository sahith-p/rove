"use client";
// /pay/[code] state machine: loading → open → (checkout) → processing (poll) → paid, plus closed / not found / failed.
// Amounts only ever come from the API (or fixtures in demo mode), never from the URL.
import { useCallback, useEffect, useRef, useState } from "react";
import { PAYMENT_CODE_RE, type PaymentStatus } from "@rove/shared";
import { Amount, Button, Card, LineItems, MerchantHeader, StatusStepper, type Step } from "../../../components";
import { format, shortHash } from "../../../lib/ui/format";
import { getInvoice, getPayment, startCheckout, type PayMethod } from "./_api";
import {
  FIXTURES_ENABLED,
  fixtureCheckout,
  fixtureInvoice,
  fixturePayment,
  simulatedStatus,
  type InvoiceKind,
  type InvoiceView,
  type PaymentView,
  type PreviewState,
} from "./_fixtures";
import { PayOptions } from "./PayOptions";
import styles from "./pay.module.css";

type ClosedReason = "expired" | "already_paid" | "cancelled";

type Phase =
  | { name: "loading" }
  | { name: "open"; invoice: InvoiceView }
  | { name: "processing"; invoice: InvoiceView; paymentId: string; payment: PaymentView | null }
  | { name: "paid"; invoice: InvoiceView; payment: PaymentView }
  | { name: "failed"; invoice: InvoiceView }
  | { name: "closed"; invoice: InvoiceView; reason: ClosedReason }
  | { name: "not_found" }
  | { name: "error" };

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
  switch (state) {
    case "loading":
      return { name: "loading" };
    case "open":
      return { name: "open", invoice };
    case "paying":
      return { name: "processing", invoice, paymentId: "pay_demo0001", payment: fixturePayment("created") };
    case "settling":
      return { name: "processing", invoice, paymentId: "pay_demo0001", payment: fixturePayment("settling") };
    case "paid":
      return { name: "paid", invoice, payment: fixturePayment("settled") };
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

function steps(status: PaymentStatus | undefined, payment: PaymentView | null): Step[] {
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
    { label: "Payment received", state: received ? "done" : "current", detail: received ? undefined : "Confirming with your bank…" },
    {
      label: "Settling on XRPL",
      state: settled ? "done" : received ? "current" : "todo",
      detail: payment?.settleTxHash ? shortHash(payment.settleTxHash, 6) : received && !settled ? "A few seconds" : undefined,
      href: payment?.explorerUrl,
    },
    { label: "Paid", state: settled ? "done" : "todo" },
  ];
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
  /** Set when a fixture checkout started a simulated settlement (ms timestamp). */
  const simStart = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!PAYMENT_CODE_RE.test(code)) return setPhase({ name: "not_found" });
    setPhase({ name: "loading" });
    const res = await getInvoice(code);
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
  useEffect(() => {
    if (!processingId) return;
    // A ?state=paying / settling preview stays frozen; a preview that was paid from ?state=open runs the simulation.
    if (preview && simStart.current === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let payment: PaymentView | null = null;
      if (simStart.current !== null) {
        payment = fixturePayment(simulatedStatus(simStart.current));
      } else {
        const res = await getPayment(processingId);
        if (res.ok) payment = res.data;
        else if (FIXTURES_ENABLED && (res.status === 501 || res.status === 404)) {
          simStart.current = Date.now();
          setUsingFixtures(true);
          payment = fixturePayment("created");
        }
      }
      if (stopped) return;
      if (payment) {
        const p = payment;
        setPhase((prev) => {
          if (prev.name !== "processing") return prev;
          if (SETTLED.includes(p.status)) return { name: "paid", invoice: prev.invoice, payment: p };
          if (p.status === "failed") return { name: "failed", invoice: prev.invoice };
          return { ...prev, payment: p };
        });
        if (SETTLED.includes(p.status) || p.status === "failed") return;
      }
      timer = setTimeout(tick, simStart.current !== null ? SIM_POLL_MS : POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [processingId, preview]);

  const onPay = useCallback(
    async (method: PayMethod) => {
      if (phase.name !== "open" || busy) return;
      const invoice = phase.invoice;
      setBusy(method);
      setCheckoutError(null);

      if (preview) {
        // Preview: skip the network, run the simulated flow.
        simStart.current = Date.now();
      } else {
        const res = await startCheckout(invoice.code, method);
        if (res.ok) {
          simStart.current = null;
          // TODO SH-A3 / SH-A4: confirm with Stripe (res.data.stripe) or the BNB wallet (res.data.bnb) here.
          setBusy(null);
          setPhase({ name: "processing", invoice, paymentId: res.data.paymentId, payment: null });
          return;
        }
        if (!(FIXTURES_ENABLED && (res.status === 501 || res.status === null))) {
          setBusy(null);
          setCheckoutError(
            res.status === 409 || res.status === 410 ? "This code can't be paid any more. Reload to check its status." : "Couldn't start the payment. Please try again.",
          );
          return;
        }
        setUsingFixtures(true);
        simStart.current = Date.now();
      }

      const checkout = fixtureCheckout(invoice);
      await new Promise((r) => setTimeout(r, 600));
      setBusy(null);
      setPhase({ name: "processing", invoice, paymentId: checkout.paymentId, payment: fixturePayment("created", method) });
    },
    [phase, busy, preview],
  );

  return (
    <main className={styles.page}>
      <Body
        phase={phase}
        code={code}
        now={now}
        busy={busy}
        checkoutError={checkoutError}
        onPay={onPay}
        onRetry={() => {
          if (preview) setPhase(previewPhase(code, "open", fixtureKind));
          else void load();
        }}
      />
      <footer className={styles.footer}>
        {usingFixtures ? <span className={styles.demo}>Demo data</span> : null}
        <span>Rove · settles on XRPL</span>
      </footer>
    </main>
  );
}

interface BodyProps {
  phase: Phase;
  code: string;
  now: number;
  busy: PayMethod | null;
  checkoutError: string | null;
  onPay: (m: PayMethod) => void;
  onRetry: () => void;
}

function Body({ phase, code, now, busy, checkoutError, onPay, onRetry }: BodyProps) {
  switch (phase.name) {
    case "loading":
      return (
        <div className={styles.loading} aria-busy="true">
          <div className={`${styles.skeleton} ${styles.skHeader}`} />
          <div className={`${styles.skeleton} ${styles.skAmount}`} />
          <div className={`${styles.skeleton} ${styles.skCard}`} />
          <p className={styles.codeLine}>Code {code}</p>
          <span className="sr-only">Loading payment…</span>
        </div>
      );

    case "open": {
      const { invoice } = phase;
      const hint = expiryHint(invoice.expiresAt, now);
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <section className={styles.hero}>
            <Amount money={invoice.total} />
            <p className={styles.meta}>
              {hint ? <span suppressHydrationWarning>{hint}</span> : null}
              {hint ? <span aria-hidden="true"> · </span> : null}
              <span>
                Code <span className={styles.code}>{invoice.code}</span>
              </span>
            </p>
          </section>
          {invoice.lines.length > 0 || invoice.note ? (
            <Card>
              {invoice.lines.length > 0 ? <LineItems lines={invoice.lines} total={invoice.total} /> : null}
              {invoice.note ? (
                <p className={styles.note}>
                  <span className={styles.noteLabel}>Note</span>
                  {invoice.note}
                </p>
              ) : null}
            </Card>
          ) : null}
          {checkoutError ? (
            <p className={styles.inlineError} role="alert">
              {checkoutError}
            </p>
          ) : null}
          <PayOptions onPay={onPay} busy={busy} />
        </>
      );
    }

    case "processing": {
      const { invoice, payment } = phase;
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <section className={styles.hero}>
            <Amount money={invoice.total} />
            <p className={styles.meta} aria-live="polite">
              {payment && payment.status !== "created" ? "Payment received. Settling…" : "Processing your payment…"}
            </p>
          </section>
          <Card>
            <StatusStepper steps={steps(payment?.status, payment)} />
          </Card>
          <p className={styles.hintCenter}>You can keep this open. It updates by itself.</p>
        </>
      );
    }

    case "paid": {
      const { invoice, payment } = phase;
      return (
        <>
          <section className={styles.paidHero}>
            <div className={styles.check} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </div>
            <h1 className={styles.paidTitle}>Paid</h1>
            <Amount money={payment.local} />
            <p className={styles.meta}>to {payment.merchantName || invoice.merchant.name}</p>
          </section>
          <Card>
            <StatusStepper steps={steps(payment.status, payment)} />
          </Card>
          <div className={styles.actions}>
            <Button fullWidth href={`/r/${encodeURIComponent(payment.paymentId)}`}>
              Receipt
            </Button>
            {payment.explorerUrl ? (
              <Button fullWidth variant="secondary" href={payment.explorerUrl} target="_blank" rel="noopener noreferrer">
                View on XRPL ↗
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
          <StateBlock tone="error" title="Payment failed" line="You weren't charged. Try again or use another method." code={code} />
          <Button fullWidth onClick={onRetry}>
            Try again
          </Button>
        </>
      );

    case "closed": {
      const { invoice, reason } = phase;
      const what = invoice.kind === "invoice" ? "invoice" : "code";
      const copy: Record<ClosedReason, { title: string; line: string; tone: "muted" | "success" }> = {
        expired: { title: "This code has expired", line: `Ask ${invoice.merchant.name} for a new one.`, tone: "muted" },
        already_paid: { title: "Already paid", line: `This ${what} has been paid. Nothing more to do.`, tone: "success" },
        cancelled: { title: "Cancelled", line: `${invoice.merchant.name} cancelled this ${what}.`, tone: "muted" },
      };
      const c = copy[reason];
      return (
        <>
          <MerchantHeader name={invoice.merchant.name} verified={invoice.merchant.verified} />
          <StateBlock tone={c.tone} title={c.title} line={c.line} code={invoice.code} amount={format(invoice.total)} />
        </>
      );
    }

    case "not_found":
      return <StateBlock tone="muted" title="Code not found" line="Check the code, or ask the shop for a new one." code={code} />;

    case "error":
      return (
        <>
          <StateBlock tone="error" title="Couldn't load this payment" line="Check your connection and try again." code={code} />
          <Button fullWidth variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </>
      );
  }
}

function StateBlock({ tone, title, line, code, amount }: { tone: "muted" | "success" | "error"; title: string; line: string; code: string; amount?: string }) {
  const icon = tone === "success" ? "✓" : tone === "error" ? "!" : "–";
  return (
    <section className={styles.state} data-tone={tone}>
      <div className={styles.stateIcon} aria-hidden="true">
        {icon}
      </div>
      <h1 className={styles.stateTitle}>{title}</h1>
      <p className={styles.stateLine}>{line}</p>
      <p className={styles.codeLine}>
        {amount ? `${amount} · ` : null}Code {code}
      </p>
    </section>
  );
}
