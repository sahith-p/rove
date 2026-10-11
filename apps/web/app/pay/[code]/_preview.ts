// SERVER ONLY. The invoice behind /pay/[code] for its static preview (generateMetadata + opengraph-image, SH-B3).
// Reads GET /api/invoices/:code; when that fails (501 until NI-B4) and NEXT_PUBLIC_DEMO_FIXTURES=1, uses the fixture.
import { format, InvoicePublicRes, ROUTES } from "@rove/shared";
import { invoiceStatus, itemSummary } from "../../../lib/og/labels";
import { getOwnJson } from "../../../lib/og/origin";
import { FIXTURES_ENABLED, fixtureInvoice, type InvoiceView, type PreviewState } from "./_fixtures";

export function normalizeCode(raw: string): string {
  let code = raw;
  try {
    code = decodeURIComponent(raw);
  } catch {
    // stray "%": keep as is
  }
  return code.trim().toUpperCase().slice(0, 32);
}

const FIXTURE_STATUS: Partial<Record<PreviewState, InvoiceView["status"]>> = {
  paid: "paid",
  already_paid: "paid",
  expired: "expired",
  cancelled: "cancelled",
};

/** null when the invoice can't be read (not found, API down outside fixture mode). */
export async function loadInvoicePreview(code: string, preview: PreviewState | null = null): Promise<InvoiceView | null> {
  const res = await getOwnJson(ROUTES.invoice(encodeURIComponent(code)));
  if (res.ok) {
    const parsed = InvoicePublicRes.safeParse(res.json);
    if (parsed.success) return parsed.data;
  }
  if (res.ok === false && res.status === 404) return null;
  if (!FIXTURES_ENABLED || preview === "not_found") return null;
  return fixtureInvoice(code, "invoice", (preview && FIXTURE_STATUS[preview]) ?? "open");
}

/** Title / description / image text for one invoice. */
export function invoiceCopy(inv: InvoiceView) {
  const amount = format(inv.total);
  const status = invoiceStatus(inv.status);
  const items = itemSummary(inv.lines);
  const title =
    inv.status === "open" ? `Pay ${amount} · ${inv.merchant.name}` : `${amount} · ${status.text} · ${inv.merchant.name}`;
  const description =
    inv.status === "open"
      ? `${items ? `${items}. ` : ""}Pay with Apple Pay, card, or a BNB Chain wallet.`
      : inv.status === "paid"
        ? `Paid to ${inv.merchant.name}. Settled on XRPL.`
        : `This payment link has ${inv.status === "expired" ? "expired" : "been cancelled"}. Ask ${inv.merchant.name} for a new one.`;
  return { amount, status, items, title, description };
}
