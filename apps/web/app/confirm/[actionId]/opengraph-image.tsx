// Static preview for the confirm card (SH-B3). Token-gated page, so the image stays generic: no data fetch.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../../lib/og/card";

export const runtime = "nodejs";
export const alt = "Confirm a request on Rove";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    eyebrow: "Action needed",
    headline: "Confirm request",
    detail: "Review it, then confirm or cancel",
    status: { label: "Needs you", tone: "pending" },
    footer: "Nothing moves until you confirm",
  });
}
