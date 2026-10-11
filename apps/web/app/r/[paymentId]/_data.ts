// SERVER ONLY. Loads the receipt for /r/[paymentId] from GET /api/payments/:id (PaymentStatusRes).
// Falls back to local fixtures when the API fails (501 until NI-B4) and NEXT_PUBLIC_DEMO_FIXTURES=1.
import { MoneyZ, PaymentStatusRes, type Money } from "@rove/shared";
import { headers } from "next/headers";
import type { z } from "zod";
import { fixtureState, receiptFixture } from "./_fixtures";

export type PaymentStatusResT = z.infer<typeof PaymentStatusRes>;
export type PaymentStatus = PaymentStatusResT["status"];

/**
 * PaymentStatusRes plus optional extras that the contract doesn't carry yet. Each one is shown only when the API
 * sends it (they'd be "new optional field" proposals); the page never invents them.
 */
export type ReceiptData = PaymentStatusResT & {
  createdAt?: string;
  refunded?: Money;
  payerName?: string;
  merchantVerified?: boolean;
};

export type ReceiptLoad =
  | { kind: "ok"; data: ReceiptData; demo: boolean }
  | { kind: "not_found" }
  | { kind: "error" };

export const PENDING: readonly PaymentStatus[] = ["created", "authorized", "settling"];

type Extras = Pick<ReceiptData, "createdAt" | "refunded" | "payerName" | "merchantVerified">;

function extras(raw: Record<string, unknown>): Extras {
  const out: Extras = {};
  if (typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))) out.createdAt = raw.createdAt;
  if (typeof raw.payerName === "string" && raw.payerName.trim()) out.payerName = raw.payerName.trim();
  if (typeof raw.merchantVerified === "boolean") out.merchantVerified = raw.merchantVerified;
  const refunded = MoneyZ.safeParse(raw.refunded);
  if (refunded.success) out.refunded = refunded.data;
  return out;
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function loadReceipt(
  paymentId: string,
  opts: { session?: string; state?: string | string[] } = {},
): Promise<ReceiptLoad> {
  const demo = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";
  try {
    const res = await fetch(`${await origin()}/api/payments/${encodeURIComponent(paymentId)}`, {
      cache: "no-store",
      headers: opts.session ? { "x-rove-session": opts.session } : undefined,
    });
    if (res.status === 404) return { kind: "not_found" };
    if (res.ok) {
      const json: unknown = await res.json();
      const parsed = PaymentStatusRes.safeParse(json); // strips unknown keys; extras are picked + validated below
      if (parsed.success) {
        return { kind: "ok", data: { ...parsed.data, ...extras(json as Record<string, unknown>) }, demo: false };
      }
    }
  } catch {
    // network / parse failure → fall through
  }
  if (demo) return { kind: "ok", data: receiptFixture(paymentId, fixtureState(opts.state)), demo: true };
  return { kind: "error" };
}
