// Client-safe demo checkout + settlement simulation for /m (NEXT_PUBLIC_DEMO_FIXTURES=1 only, after the API says 501).
// No @rove/shared/mocks here (node:crypto); the shop itself comes from the server as a prop. Money is bigint minor units.
import {
  CheckoutRes,
  PaymentStatusRes,
  fromMinor,
  toMinor,
  type Currency,
  type InvoiceLine,
  type Money,
  type PaymentStatus,
} from "@rove/shared";
import type { CheckoutView, PaymentView } from "./_types";

/** Demo rate: 1.2860 SGD per USD, as basis points (×10⁴). Same as the /pay fixtures (S$12.50 → US$9.72). */
const RATE = "1.2860";
const RATE_BP = 12_860n;
const DEMO_TX = "4B7E1C9A2D6F83E05A1B4C7D9E2F6083C5A1B47E9D3F0628A4B7E1C5D9F2083A";

/** local SGD → USD at the demo rate, rounded half up to the cent. */
function toUsd(local: Money): Money {
  if (local.currency === "USD") return local;
  const minor = toMinor(local);
  return fromMinor((minor * 10_000n * 2n + RATE_BP) / (RATE_BP * 2n), "USD");
}

function demoId(): string {
  return `pay_demo${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

/** What checkout would return: USD payers (and every BNB payer) pay the USD quote; SGD payers pay the local total. */
export function simCheckout(local: Money, payCurrency: Currency, method: "card" | "bnb" | "ausd"): CheckoutView {
  const usd = toUsd(local);
  const sendMax = fromMinor((toMinor(usd) * 101n + 99n) / 100n, "USD");
  const charge = method !== "card" || payCurrency === "USD" ? usd : local;
  return CheckoutRes.parse({
    paymentId: demoId(),
    local,
    charge,
    quote: { local, usd, rate: RATE, sendMaxUsd: sendMax.amount, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
  });
}

export interface Sim {
  start: number;
  paymentId: string;
  method: PaymentView["method"];
  local: Money;
  charge: Money | undefined;
  lines: InvoiceLine[];
  merchantName: string;
}

/** ~1.5s per step after a demo checkout. */
export function simStatus(start: number, now: number = Date.now()): PaymentStatus {
  const t = now - start;
  if (t < 1500) return "created";
  if (t < 3000) return "authorized";
  if (t < 4500) return "settling";
  return "settled";
}

export function simPayment(sim: Sim, status: PaymentStatus = simStatus(sim.start)): PaymentView {
  const onLedger = status === "settled";
  return PaymentStatusRes.parse({
    paymentId: sim.paymentId,
    status,
    local: sim.local,
    charge: sim.charge,
    merchantName: sim.merchantName,
    lines: sim.lines,
    method: sim.method,
    ...(onLedger ? { settleTxHash: DEMO_TX, explorerUrl: `https://testnet.xrpl.org/transactions/${DEMO_TX}` } : {}),
  });
}
