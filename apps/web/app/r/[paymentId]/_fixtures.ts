// Demo fixtures for /r/[paymentId] while GET /api/payments/:id is still 501 (NI-B4).
// Only used when NEXT_PUBLIC_DEMO_FIXTURES=1. Built from @rove/shared/mocks so the numbers match the rest of the demo.
import { money } from "@rove/shared";
import { DEMO_CUSTOMER, DEMO_MERCHANT, demoPayment } from "@rove/shared/mocks";
import type { PaymentStatus, ReceiptData } from "./_data";

const FIXTURE_STATES = ["settled", "refunded", "partially_refunded", "settling", "failed"] as const satisfies readonly PaymentStatus[];
export type FixtureState = (typeof FIXTURE_STATES)[number];

const DEMO_TX = "8F3B2C1D9E0A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9012ABCDEF";

/** `?state=` → a fixture state; anything else → "settled". */
export function fixtureState(raw: string | string[] | undefined): FixtureState {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (FIXTURE_STATES as readonly string[]).includes(v ?? "") ? (v as FixtureState) : "settled";
}

/** A valid PaymentStatusRes, plus the optional extras the receipt shows when the API provides them. */
export function receiptFixture(paymentId: string, state: FixtureState): ReceiptData {
  const p = demoPayment({ id: paymentId, status: state, createdAt: new Date(Date.now() - 4 * 60_000).toISOString() });
  const onLedger = state !== "settling" && state !== "failed";
  return {
    paymentId: p.id,
    status: p.status,
    local: p.local,
    merchantName: DEMO_MERCHANT.name,
    lines: p.lines,
    method: p.method,
    ...(onLedger ? { settleTxHash: DEMO_TX, explorerUrl: `https://testnet.xrpl.org/transactions/${DEMO_TX}` } : {}),
    createdAt: p.createdAt,
    payerName: DEMO_CUSTOMER.name,
    merchantVerified: true,
    ...(state === "refunded" ? { refunded: p.local } : state === "partially_refunded" ? { refunded: money("5.50", "SGD") } : {}),
  };
}
