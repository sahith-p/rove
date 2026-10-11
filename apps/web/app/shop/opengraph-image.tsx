// Static preview for the shop card (SH-B3). Token-gated page, so the image stays generic: no data fetch.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../lib/og/card";

export const runtime = "nodejs";
export const alt = "Your shop on Rove";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    eyebrow: "My shop",
    headline: "Your shop",
    detail: "Balance, payments, invoices and payouts",
    status: { label: "Live", tone: "success", icon: "dot" },
    footer: "Change anything by texting Rove",
  });
}
