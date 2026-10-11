// Static preview for the bank card (SH-B3). Token-gated page, so the image stays generic: no data fetch.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../lib/og/card";

export const runtime = "nodejs";
export const alt = "Add your bank to Rove, securely";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    eyebrow: "Payouts",
    headline: "Add your bank",
    detail: "Sent straight to our licensed payout partner",
    status: { label: "Secure", tone: "success", icon: "lock" },
    footer: "Rove only keeps the last 4 digits",
  });
}
