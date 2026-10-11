// Static preview for the invoice card (SH-B3): "S$12.50" + merchant + Open / Paid ✓ / Expired + items.
// OG image routes don't get searchParams, so the state comes from the invoice itself.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../../lib/og/card";
import { invoiceCopy, loadInvoicePreview, normalizeCode } from "./_preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "Rove payment request";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const code = normalizeCode((await params).code);
  const inv = await loadInvoicePreview(code);
  if (!inv) {
    return ogCard({ eyebrow: "Payment request", headline: "Pay with Rove", detail: "Apple Pay, card, or a BNB Chain wallet" });
  }
  const copy = invoiceCopy(inv);
  return ogCard({
    eyebrow: inv.merchant.name,
    headline: copy.amount,
    amount: true,
    detail: copy.items || inv.note || undefined,
    status: { label: copy.status.label, tone: copy.status.tone },
    footer: inv.status === "open" ? "Apple Pay · Card · BNB Chain" : inv.status === "paid" ? "Settled on XRPL" : "Ask the shop for a new link",
    meta: inv.code,
  });
}
