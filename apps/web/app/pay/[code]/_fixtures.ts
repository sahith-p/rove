// Demo fixtures for /pay/[code] while the invoice / checkout / payment APIs return 501.
// Only used when NEXT_PUBLIC_DEMO_FIXTURES=1. Built from @rove/shared/mocks and validated with the contract schemas.
import { CheckoutRes, InvoicePublicRes, PaymentStatusRes, type PaymentStatus } from "@rove/shared";
import { DEMO_MERCHANT, demoInvoice, demoPayment } from "@rove/shared/mocks";
import type { z } from "zod";

export type InvoiceView = z.infer<typeof InvoicePublicRes>;
export type PaymentView = z.infer<typeof PaymentStatusRes>;
export type CheckoutView = z.infer<typeof CheckoutRes>;
export type InvoiceKind = InvoiceView["kind"];

export const FIXTURES_ENABLED = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

/** `?state=` values the page can preview in fixture mode. */
export const PREVIEW_STATES = [
  "loading",
  "open",
  "paying",
  "settling",
  "paid",
  "failed",
  "expired",
  "already_paid",
  "cancelled",
  "not_found",
  "error",
] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export function asPreviewState(v: string | undefined): PreviewState | null {
  return v && (PREVIEW_STATES as readonly string[]).includes(v) ? (v as PreviewState) : null;
}

const MIN = 60_000;
const EXPIRY_MS: Record<InvoiceKind, number> = { invoice: 7 * 24 * 60 * MIN, one_time_qr: 24 * MIN, pay_request: 60 * MIN };

const DEMO_TX = "9C4F1B7E2A6D83F05B1E4C7A9D2F6083B5E1A47C9D3F0628B4E7A1C5D9F2083B";

export function fixtureInvoice(code: string, kind: InvoiceKind = "invoice", status: InvoiceView["status"] = "open"): InvoiceView {
  const inv = demoInvoice({ code });
  return InvoicePublicRes.parse({
    code: inv.code,
    kind,
    merchant: { id: DEMO_MERCHANT.id, name: DEMO_MERCHANT.name, verified: true },
    lines: inv.lines,
    total: inv.total,
    note: kind === "invoice" ? "Thanks for lunch today!" : null,
    status,
    expiresAt: new Date(Date.now() + EXPIRY_MS[kind]).toISOString(),
  });
}

export function fixturePayment(status: PaymentStatus, method: PaymentView["method"] = "apple_pay"): PaymentView {
  const p = demoPayment({ status, method });
  const onLedger = status === "settled" || status === "refunded" || status === "partially_refunded";
  return PaymentStatusRes.parse({
    paymentId: p.id,
    status,
    local: p.local,
    merchantName: DEMO_MERCHANT.name,
    lines: p.lines,
    method,
    ...(onLedger ? { settleTxHash: DEMO_TX, explorerUrl: `https://testnet.xrpl.org/transactions/${DEMO_TX}` } : {}),
  });
}

export function fixtureCheckout(invoice: InvoiceView): CheckoutView {
  return CheckoutRes.parse({
    paymentId: demoPayment().id,
    local: invoice.total,
    quote: {
      local: invoice.total,
      usd: { amount: "9.69", currency: "USD" },
      rate: "1.29",
      sendMaxUsd: "9.79",
      expiresAt: new Date(Date.now() + 5 * MIN).toISOString(),
    },
  });
}

/** Simulated settlement timeline (~1.5s per step) after a fixture checkout. */
export function simulatedStatus(startedAt: number, now: number = Date.now()): PaymentStatus {
  const t = now - startedAt;
  if (t < 1500) return "created";
  if (t < 3000) return "authorized";
  if (t < 4500) return "settling";
  return "settled";
}
