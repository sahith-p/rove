// Customer: pay an invoice / one-time QR / pay request (Apple Pay / card / BNB wallet) → paid state → receipt
// Owner: Sahith · Task: SH-A2 (page), SH-A3 (Stripe), SH-A4 (BNB) · Spec: docs/specs/web-app.md
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
import type { Metadata } from "next";
import { asPreviewState, FIXTURES_ENABLED, type InvoiceKind } from "./_fixtures";
import { PayClient } from "./PayClient";

type Params = Promise<{ code: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const KINDS: InvoiceKind[] = ["invoice", "one_time_qr", "pay_request"];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// TODO SH-B3: "Pay Ah Seng Chicken Rice · S$12.50" + per-state OG image once the invoice API can be read server-side.
export async function generateMetadata(): Promise<Metadata> {
  return { title: "Pay with Rove", description: "Pay with Apple Pay, card, or a BNB Chain wallet. Settles on XRPL." };
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ code: raw }, sp] = await Promise.all([params, searchParams]);
  const code = decodeURIComponent(raw).trim().toUpperCase().slice(0, 32);

  // Fixture-mode previews only; the amount never comes from the URL.
  const preview = FIXTURES_ENABLED ? asPreviewState(first(sp.state)) : null;
  const kindParam = first(sp.kind) as InvoiceKind | undefined;
  const fixtureKind: InvoiceKind = FIXTURES_ENABLED && kindParam && KINDS.includes(kindParam) ? kindParam : "invoice";

  return <PayClient key={`${code}:${preview ?? ""}:${fixtureKind}`} code={code} preview={preview} fixtureKind={fixtureKind} />;
}
