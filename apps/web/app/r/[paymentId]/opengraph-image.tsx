// Static preview for the receipt / sale card (SH-B3): "Receipt" + amount (what the payer was charged) + Paid ✓ / Refunded.
// OG image routes don't get searchParams, so the state comes from the payment itself (customer view, no session).
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../../lib/og/card";
import { shortHash } from "../../../lib/ui/format";
import { loadReceipt } from "./_data";
import { METHOD_LABEL, receiptCopy } from "./_preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "Rove receipt";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const load = await loadReceipt(paymentId);
  if (load.kind !== "ok") {
    return ogCard({ eyebrow: "Receipt", headline: "Your receipt", detail: "Paid with Rove · settled on XRPL" });
  }
  const { data } = load;
  const copy = receiptCopy(data);
  return ogCard({
    eyebrow: "Receipt",
    headline: copy.amount,
    amount: true,
    detail: copy.foreign
      ? `${copy.local} to the shop · no card FX fees`
      : copy.items || `Paid with ${METHOD_LABEL[data.method]}`,
    status: { label: copy.status.label, tone: copy.status.tone },
    footer: data.merchantName,
    verified: data.merchantVerified === true,
    meta: data.paymentId.length <= 14 ? data.paymentId : shortHash(data.paymentId, 6),
  });
}
