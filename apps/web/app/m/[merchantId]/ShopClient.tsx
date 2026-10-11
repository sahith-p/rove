"use client";
// /m/[merchantId] state machine: pick (menu | amount) → review (currency + pay options) → processing (poll) → paid / failed.
// Totals on this page are previews built with bigint money math; the server prices items from the DB and charges `charge`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { E164, cmp, isPositive, money, type Currency, type InvoiceLine, type Money, type PaymentStatus } from "@rove/shared";
import { ArrowRight, ArrowUpRight, Check, ChevronLeft, Minus, Plus, Receipt, RotateCw, X } from "lucide-react";
import {
  Amount,
  Button,
  Card,
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
import { linesTotal } from "../../../lib/ui/lines";
import { CurrencyToggle, localeCurrency } from "../../pay/[code]/CurrencyToggle";
import { PayOptions } from "../../pay/[code]/PayOptions";
import payStyles from "../../pay/[code]/pay.module.css";
import { contractMethod, getPayment, startShopCheckout, type PayMethod } from "./_api";
import { simCheckout, simPayment, simStatus, type Sim } from "./_sim";
import type { CheckoutView, PaymentView, Selection, ShopView } from "./_types";
import styles from "./shop.module.css";

const DEMO = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";
const POLL_MS = 1000;
const SIM_POLL_MS = 500;
const MAX_QTY = 99;
const SETTLED: PaymentStatus[] = ["settled", "partially_refunded", "refunded"];

type Mode = "menu" | "amount";

/** A priced preview of what the payer picked. `local` is display only; checkout sends ids + qty or the typed amount. */
interface Order {
  selection: Selection;
  lines: InvoiceLine[];
  local: Money;
}

type Phase =
  | { name: "pick" }
  | { name: "review"; order: Order }
  | { name: "processing"; order: Order; checkout: CheckoutView | null; paymentId: string; payment: PaymentView | null }
  | { name: "paid"; order: Order; checkout: CheckoutView | null; payment: PaymentView }
  | { name: "failed"; order: Order };

interface Held {
  checkout: CheckoutView;
  currency: Currency;
  method: "card" | "bnb";
  phone: string | null;
  simulated: boolean;
}

// ---------------------------------------------------------------- input helpers

/** Keeps digits and one dot, at most 2 decimals and 4 whole digits. ".5" → "0.5". */
function cleanAmount(raw: string): string {
  let s = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  if (s.startsWith(".")) s = `0${s}`;
  const [whole = "", frac] = s.split(".");
  const w = whole.replace(/^0+(?=\d)/, "").slice(0, 4);
  return frac === undefined ? w : `${w}.${frac.slice(0, 2)}`;
}

type AmountCheck = { money: Money | null; error: string | null };

function checkAmount(text: string, currency: Currency, max: Money): AmountCheck {
  const s = text.endsWith(".") ? text.slice(0, -1) : text;
  if (!s) return { money: null, error: null };
  let m: Money;
  try {
    m = money(s, currency);
  } catch {
    return { money: null, error: "Enter an amount like 6.50" };
  }
  if (!isPositive(m)) return { money: null, error: `Enter an amount above ${format(money("0", currency))}` };
  if (cmp(m, max) > 0) return { money: null, error: `Up to ${format(max)} per payment` };
  return { money: m, error: null };
}

/** "9123 4567" → "+6591234567", "0065 9123 4567" → "+6591234567", "+1 (555) 010-0199" → "+15550100199". */
function normalizePhone(raw: string): string {
  let s = raw.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^[689]\d{7}$/.test(s)) s = `+65${s}`;
  return s;
}

/** null = blank (fine), string = valid E.164, false = invalid. */
function checkPhone(raw: string): string | null | false {
  if (!raw.trim()) return null;
  const n = normalizePhone(raw);
  return E164.safeParse(n).success ? n : false;
}

// ---------------------------------------------------------------- display helpers

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

/** Before a quote: the preview total in the shop's currency. After: `charge` in the payer's currency. */
function ChargeAmount({
  shopName,
  order,
  checkout,
  payment,
  payCurrency,
  label,
}: {
  label?: string;
  shopName: string;
  order: Order;
  checkout: CheckoutView | null;
  payment?: PaymentView | null;
  payCurrency?: Currency | null;
}) {
  const charge = payment?.charge ?? checkout?.charge;
  if (!charge) {
    const sub =
      payCurrency && payCurrency !== order.local.currency
        ? `Charged in ${payCurrency} at today's rate · no card FX fees`
        : `To ${shopName} · final total confirmed at checkout`;
    return <Amount money={payment?.local ?? order.local} sub={sub} label={label} />;
  }
  const local = payment?.local ?? checkout?.local ?? order.local;
  const converted = charge.currency !== local.currency;
  const sub = converted
    ? `${format(local)} to ${shopName}${checkout ? ` · rate ${checkout.quote.rate}` : ""} · no card FX fees`
    : `To ${shopName} · no conversion · no card FX fees`;
  return <Amount money={charge} sub={sub} label={label} />;
}

function itemsLabel(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- component

export interface ShopClientProps {
  shop: ShopView;
  /** true when the shop came from demo fixtures (the API returned 501). */
  demo: boolean;
}

export function ShopClient({ shop, demo }: ShopClientProps) {
  const menu = useMemo(() => shop.menu.filter((m) => m.active), [shop.menu]);
  const max = useMemo(() => money("500", shop.currency), [shop.currency]);

  const [phase, setPhase] = useState<Phase>({ name: "pick" });
  const [mode, setMode] = useState<Mode>(menu.length > 0 ? "menu" : "amount");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [amountText, setAmountText] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);

  const [busy, setBusy] = useState<PayMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingFixtures, setUsingFixtures] = useState(demo);
  const [payCurrency, setPayCurrency] = useState<Currency | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [quoting, setQuoting] = useState(false);
  /** A live card checkout waiting for the payer in Stripe's sheet (replaces the pay buttons on review). */
  const [intent, setIntent] = useState<StripeIntent<CheckoutView> | null>(null);
  const sim = useRef<Sim | null>(null);

  useEffect(() => setPayCurrency(localeCurrency()), []);

  // Back from a Stripe redirect (3DS): rebuild the order from the payment and resume polling it.
  useEffect(() => {
    const back = readStripeReturn();
    if (!back) return;
    clearStripeReturn();
    if (back.status === "failed") return setError("Your payment didn't go through. Try again or use another method.");
    void getPayment(back.paymentId).then((res) => {
      if (!res.ok) return setError("Couldn't load your payment. Check the receipt text, or try again.");
      const p = res.data;
      const o: Order = { selection: { kind: "amount", amount: p.local.amount }, lines: p.lines, local: p.local };
      setPhase({ name: "processing", order: o, checkout: null, paymentId: p.paymentId, payment: p });
    });
  }, []);

  // ------------------------------------------------ derived order

  const amount = useMemo(() => checkAmount(amountText, shop.currency, max), [amountText, shop.currency, max]);
  const lines = useMemo<InvoiceLine[]>(
    () => menu.filter((m) => (cart[m.id] ?? 0) > 0).map((m) => ({ menuItemId: m.id, name: m.name, qty: cart[m.id] ?? 0, unit: m.price })),
    [menu, cart],
  );
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);
  const menuTotal = useMemo(() => linesTotal(lines, shop.currency), [lines, shop.currency]);
  const overMax = mode === "menu" && cmp(menuTotal, max) > 0;

  const order = useMemo<Order | null>(() => {
    if (mode === "menu") {
      if (lines.length === 0 || overMax) return null;
      return { selection: { kind: "items", items: lines.map((l) => ({ menuItemId: l.menuItemId ?? "", qty: l.qty })) }, lines, local: menuTotal };
    }
    if (!amount.money) return null;
    return { selection: { kind: "amount", amount: amount.money.amount }, lines: [], local: amount.money };
  }, [mode, lines, overMax, menuTotal, amount.money]);

  const phoneCheck = checkPhone(phone);

  // ------------------------------------------------ pick actions

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    // One or the other: choosing a mode clears the other's picks.
    if (next === "amount") setCart({});
    else setAmountText("");
  };

  const bump = (id: string, delta: number) =>
    setCart((c) => {
      const qty = Math.min(MAX_QTY, Math.max(0, (c[id] ?? 0) + delta));
      const next = { ...c };
      if (qty === 0) delete next[id];
      else next[id] = qty;
      return next;
    });

  const toReview = () => {
    if (!order) return;
    setError(null);
    setHeld(null);
    setPhase({ name: "review", order });
    window.scrollTo({ top: 0 });
  };

  const backToPick = () => {
    if (busy) return;
    setError(null);
    setHeld(null);
    setIntent(null);
    setPhase({ name: "pick" });
  };

  const newOrder = () => {
    sim.current = null;
    setCart({});
    setAmountText("");
    setHeld(null);
    setIntent(null);
    setError(null);
    setMode(menu.length > 0 ? "menu" : "amount");
    setPhase({ name: "pick" });
    window.scrollTo({ top: 0 });
  };

  // ------------------------------------------------ polling (same as /pay)

  const processingId = phase.name === "processing" ? phase.paymentId : null;
  useEffect(() => {
    if (!processingId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let payment: PaymentView | null = null;
      const s = sim.current;
      if (s) {
        payment = simPayment(s, simStatus(s.start));
      } else {
        const res = await getPayment(processingId);
        if (res.ok) payment = res.data;
        else if (DEMO && (res.status === 501 || res.status === 404)) {
          setUsingFixtures(true);
          setPhase((prev) => {
            if (prev.name === "processing") {
              sim.current = {
                start: Date.now(),
                paymentId: prev.paymentId,
                method: "card",
                local: prev.checkout?.local ?? prev.order.local,
                charge: prev.checkout?.charge,
                lines: prev.order.lines,
                merchantName: shop.name,
              };
            }
            return prev;
          });
        }
      }
      if (stopped) return;
      if (payment) {
        const p = payment;
        setPhase((prev) => {
          if (prev.name !== "processing") return prev;
          if (SETTLED.includes(p.status)) return { name: "paid", order: prev.order, checkout: prev.checkout, payment: p };
          if (p.status === "failed") return { name: "failed", order: prev.order };
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
  }, [processingId, shop.name]);

  // ------------------------------------------------ checkout

  const checkout = useCallback(
    async (o: Order, method: PayMethod, currency: Currency, payerPhone: string | null): Promise<{ data: CheckoutView; simulated: boolean } | null> => {
      const res = await startShopCheckout(shop.id, o.selection, method, currency, payerPhone);
      if (res.ok) return { data: res.data, simulated: false };
      if (DEMO && (res.status === 501 || res.status === null)) {
        setUsingFixtures(true);
        return { data: simCheckout(o.local, currency, contractMethod(method)), simulated: true };
      }
      setError(
        res.status === 400 || res.status === 422
          ? "Something in this order can't be paid. Go back and check it."
          : res.status === 404 || res.status === 409 || res.status === 410
            ? "This shop isn't taking payments right now."
            : "Couldn't start the payment. Please try again.",
      );
      return null;
    },
    [shop.id],
  );

  const validPhone = (): string | null | false => {
    const p = checkPhone(phone);
    if (p === false) {
      setPhoneTouched(true);
      setError("Check your phone number (e.g. +65 9123 4567), or leave it blank.");
    }
    return p;
  };

  const onCurrency = useCallback(
    async (currency: Currency) => {
      setPayCurrency(currency);
      if (phase.name !== "review" || busy) return;
      const p = checkPhone(phone);
      if (p === false) return setHeld(null);
      setQuoting(true);
      setError(null);
      const res = await checkout(phase.order, "card", currency, p);
      setQuoting(false);
      setHeld(res ? { checkout: res.data, currency, method: "card", phone: p, simulated: res.simulated } : null);
      // Stripe's sheet is open: swap it to the new currency's PaymentIntent (or close it if that failed).
      setIntent((prev) => (prev ? toIntent(res, currency, prev.preferCard) : null));
    },
    [phase, busy, phone, checkout],
  );

  const onPay = async (method: PayMethod) => {
    if (phase.name !== "review" || busy || quoting) return;
    const p = validPhone();
    if (p === false) return;
    const o = phase.order;
    const currency = payCurrency ?? "USD";
    setBusy(method);
    setError(null);

    const reusable =
      held &&
      held.method === contractMethod(method) &&
      held.currency === currency &&
      held.phone === p &&
      Date.parse(held.checkout.quote.expiresAt) > Date.now();
    const res = reusable ? { data: held.checkout, simulated: held.simulated } : await checkout(o, method, currency, p);
    if (!res) return setBusy(null);

    if (res.simulated) {
      sim.current = {
        start: Date.now(),
        paymentId: res.data.paymentId,
        method,
        local: res.data.local,
        charge: res.data.charge,
        lines: o.lines,
        merchantName: shop.name,
      };
      await new Promise((r) => setTimeout(r, 600));
    } else if (contractMethod(method) === "card") {
      // Live card checkout: stay on review with Stripe's sheet; ExpressPay → onStripePaid moves to processing.
      sim.current = null;
      setBusy(null);
      setHeld(null);
      const next = toIntent(res, currency, method === "card");
      if (!next) return setError("Couldn't start the card payment. Please try again.");
      return setIntent(next);
    } else {
      // Crypto methods go through PayOptions' `crypto` handlers (components/privy), not onPay.
      sim.current = null;
    }
    setBusy(null);
    setHeld(null);
    setPhase({
      name: "processing",
      order: o,
      checkout: res.data,
      paymentId: res.data.paymentId,
      payment: sim.current ? simPayment(sim.current, "created") : null,
    });
    window.scrollTo({ top: 0 });
  };

  /** Crypto lanes (SH-A4): the buttons in components/privy run the wallet steps; the page owns checkout and polling. */
  const crypto: CryptoHandlers = {
    start: async (method: CryptoMethod) => {
      if (phase.name !== "review") return null;
      const p = validPhone();
      if (p === false) return null;
      const o = phase.order;
      setError(null);
      const res = await checkout(o, method, "USD", p);
      if (!res) return null;
      if (!res.simulated) return res.data;
      // Demo mode (no backend): no wallet step, just run the simulated settlement.
      sim.current = {
        start: Date.now(),
        paymentId: res.data.paymentId,
        method,
        local: res.data.local,
        charge: res.data.charge,
        lines: o.lines,
        merchantName: shop.name,
      };
      setPhase({ name: "processing", order: o, checkout: res.data, paymentId: res.data.paymentId, payment: simPayment(sim.current, "created") });
      window.scrollTo({ top: 0 });
      return null;
    },
    submitted: (c: CheckoutView) => {
      sim.current = null;
      setHeld(null);
      setPhase((prev) => (prev.name === "review" ? { name: "processing", order: prev.order, checkout: c, paymentId: c.paymentId, payment: null } : prev));
      window.scrollTo({ top: 0 });
    },
  };

  /** Stripe confirmed the PaymentIntent: poll our payment through the webhook (authorized) and settlement (settled). */
  const onStripePaid = () => {
    if (phase.name !== "review" || !intent) return;
    sim.current = null;
    setPhase({ name: "processing", order: phase.order, checkout: intent.checkout, paymentId: intent.checkout.paymentId, payment: null });
    setIntent(null);
    window.scrollTo({ top: 0 });
  };

  // ------------------------------------------------ render

  const header = <MerchantHeader name={shop.name} verified={shop.verified} />;
  const footer = (
    <PageFooter demo={usingFixtures} className={payStyles.footer}>
      Settles on XRPL
    </PageFooter>
  );

  if (phase.name === "pick") {
    const barLabel =
      mode === "menu" ? (itemCount > 0 ? itemsLabel(itemCount) : "No items yet") : amount.money ? "Your amount" : "Enter an amount";
    const barTotal = mode === "menu" ? menuTotal : (amount.money ?? money("0", shop.currency));
    return (
      <main className={`${payStyles.page} ${styles.pickPage}`}>
        <div className={styles.top}>
          {header}
          <h1 className={`twoTone ${styles.headline}`}>
            <span>What are you having?</span>
            <span>Pick, then pay. No app needed.</span>
          </h1>
        </div>

        {menu.length > 0 ? (
          <div className={styles.modeSwitch} role="tablist" aria-label="Pay for menu items or another amount">
            {(["menu", "amount"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                aria-controls={`panel-${m}`}
                className={mode === m ? styles.modeOn : styles.mode}
                onClick={() => switchMode(m)}
              >
                {m === "menu" ? "Menu" : "Amount"}
              </button>
            ))}
          </div>
        ) : null}

        {mode === "menu" ? (
          <section id="panel-menu" role="tabpanel" aria-label="Menu">
            <ul className={styles.menu}>
              {menu.map((item) => {
                const qty = cart[item.id] ?? 0;
                return (
                  <li key={item.id} className={qty > 0 ? styles.itemOn : styles.item}>
                    <div className={styles.itemText}>
                      <span className={styles.itemName}>{item.name}</span>
                      <span className={styles.itemPrice}>{format(item.price)}</span>
                    </div>
                    {qty === 0 ? (
                      <button type="button" className={styles.add} onClick={() => bump(item.id, 1)} aria-label={`Add ${item.name}`}>
                        <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                        Add
                      </button>
                    ) : (
                      <div className={styles.stepper}>
                        <button type="button" className={styles.stepBtn} onClick={() => bump(item.id, -1)} aria-label={`Remove one ${item.name}`}>
                          <Minus size={16} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                        <span className={styles.qty} aria-live="polite" aria-label={`${qty} ${item.name}`}>
                          {qty}
                        </span>
                        <button
                          type="button"
                          className={styles.stepBtn}
                          onClick={() => bump(item.id, 1)}
                          disabled={qty >= MAX_QTY}
                          aria-label={`Add one more ${item.name}`}
                        >
                          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {overMax ? (
              <p className={payStyles.inlineError} role="alert">
                Up to {format(max)} per payment. Remove a few items.
              </p>
            ) : null}
            <button type="button" className={styles.switchLink} onClick={() => switchMode("amount")}>
              Pay another amount instead
            </button>
          </section>
        ) : (
          <section id="panel-amount" role="tabpanel" aria-label="Pay another amount" className={styles.amountPanel}>
            <label htmlFor="amount" className={styles.label}>
              Pay another amount
            </label>
            <div className={amount.error ? styles.amountFieldError : styles.amountField}>
              <span className={styles.currencyPrefix} aria-hidden="true">
                {shop.currency === "SGD" ? "S$" : "US$"}
              </span>
              <input
                id="amount"
                className={styles.amountInput}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amountText}
                onChange={(e) => setAmountText(cleanAmount(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") toReview();
                }}
                aria-invalid={amount.error ? true : undefined}
                aria-describedby="amount-help"
              />
            </div>
            <p id="amount-help" className={amount.error ? styles.helpError : styles.help} role={amount.error ? "alert" : undefined}>
              {amount.error ?? `Type what ${shop.name} told you. Up to ${format(max)}.`}
            </p>
          </section>
        )}

        <div className={styles.bar}>
          <div className={styles.barInfo}>
            <span className={styles.barLabel}>{barLabel}</span>
            <span className={styles.barTotal}>{format(barTotal)}</span>
          </div>
          <Button onClick={toReview} disabled={!order} className={styles.barButton} trailingIcon={<ArrowRight size={16} strokeWidth={1.75} />}>
            Pay
          </Button>
        </div>
        {footer}
      </main>
    );
  }

  if (phase.name === "review") {
    const { order: o } = phase;
    const heldCheckout = intent ? intent.checkout : held && held.currency === payCurrency ? held.checkout : null;
    const phoneInvalid = phoneTouched && phoneCheck === false;
    return (
      <main className={payStyles.page}>
        <button type="button" className={styles.back} onClick={backToPick} disabled={busy !== null}>
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Edit order
        </button>
        {header}
        <section className={payStyles.hero} aria-busy={quoting || undefined}>
          <ChargeAmount shopName={shop.name} order={o} checkout={heldCheckout} payCurrency={payCurrency} label="Amount due" />
          {payCurrency ? <CurrencyToggle value={payCurrency} onChange={onCurrency} disabled={busy !== null || quoting} busy={quoting} /> : null}
        </section>
        <Card label="Order">
          {o.lines.length > 0 ? (
            <LineItems lines={o.lines} totalLabel="Total" />
          ) : (
            <div className={styles.amountRow}>
              <span>Amount</span>
              <span>{format(o.local)}</span>
            </div>
          )}
        </Card>

        <div className={styles.phoneBlock}>
          <label htmlFor="phone" className={styles.label}>
            Text me a receipt <span className={styles.optional}>Optional</span>
          </label>
          <input
            id="phone"
            className={phoneInvalid ? styles.phoneInputError : styles.phoneInput}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+65 9123 4567"
            value={phone}
            maxLength={24}
            onChange={(e) => {
              setPhone(e.target.value);
              setHeld(null);
              setIntent(null);
              if (error) setError(null);
            }}
            onBlur={() => setPhoneTouched(true)}
            aria-invalid={phoneInvalid || undefined}
            aria-describedby="phone-help"
          />
          <p id="phone-help" className={phoneInvalid ? styles.helpError : styles.help}>
            {phoneInvalid
              ? "Include your country code, e.g. +65 9123 4567."
              : typeof phoneCheck === "string" && phoneCheck !== phone.replace(/\s/g, "")
                ? `We'll text ${phoneCheck}`
                : "Singapore numbers can skip the +65."}
          </p>
        </div>

        {error ? (
          <p className={payStyles.inlineError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={payStyles.payBlock}>
          {intent ? (
            quoting ? null : (
              <ExpressPay key={intent.checkout.stripe.clientSecret} intent={intent} onPaid={onStripePaid} onCancel={() => setIntent(null)} />
            )
          ) : (
            <PayOptions onPay={onPay} busy={busy} disabled={quoting} crypto={crypto} />
          )}
        </div>
        {footer}
      </main>
    );
  }

  if (phase.name === "processing") {
    const { order: o, checkout: c, payment } = phase;
    return (
      <main className={payStyles.page}>
        {header}
        <section className={payStyles.hero}>
          <ChargeAmount shopName={shop.name} order={o} checkout={c} payment={payment} label="Paying" />
        </section>
        <Card label="Status">
          <p className={payStyles.statusLine} aria-live="polite">
            {payment && payment.status !== "created" ? "Payment received. Settling…" : "Processing your payment…"}
          </p>
          <StatusStepper steps={steps(payment?.status, payment, c)} />
        </Card>
        <p className={payStyles.hintCenter}>You can keep this open. It updates by itself.</p>
        {footer}
      </main>
    );
  }

  if (phase.name === "paid") {
    const { order: o, checkout: c, payment } = phase;
    return (
      <main className={payStyles.page}>
        <section className={payStyles.paidHero}>
          <IconBadge tone="success" size="lg">
            <Check size={30} strokeWidth={2.25} />
          </IconBadge>
          <h1 className={`twoTone ${payStyles.paidTitle}`}>
            <span>Paid</span>
            <span>{payment.merchantName || shop.name}</span>
          </h1>
        </section>
        <ChargeAmount shopName={payment.merchantName || shop.name} order={o} checkout={c} payment={payment} />
        <Card label="Status">
          <StatusStepper steps={steps(payment.status, payment)} />
        </Card>
        <div className={payStyles.actions}>
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
          <button type="button" className={styles.textButton} onClick={newOrder}>
            Start a new order
          </button>
        </div>
        {footer}
      </main>
    );
  }

  // failed
  return (
    <main className={payStyles.page}>
      {header}
      <StateBlock
        tone="error"
        icon={<X size={22} strokeWidth={1.75} />}
        title="Payment failed"
        line="You weren't charged. Try again or use another method."
        facts={[["Amount", format(phase.order.local)]]}
      />
      <Button
        fullWidth
        icon={<RotateCw size={18} strokeWidth={1.75} />}
        onClick={() => {
          sim.current = null;
          setError(null);
          setPhase({ name: "review", order: phase.order });
        }}
      >
        Try again
      </Button>
      {footer}
    </main>
  );
}
