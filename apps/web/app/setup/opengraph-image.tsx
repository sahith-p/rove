// Static preview for the setup card (SH-B3). Token-gated page, so the image stays generic: no data fetch.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../lib/og/card";

export const runtime = "nodejs";
export const alt = "Set up your shop on Rove";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    eyebrow: "For merchants",
    headline: "Set up your shop",
    detail: "Name, category and menu in one place",
    status: { label: "2 minutes", tone: "neutral" },
    footer: "Change anything later by texting Rove",
  });
}
