// OG / card preview image for /m/[merchantId]: shop name + "Scan to pay", in the shared lib/og layout. Node runtime.
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../../lib/og/card";
import { loadShop, normalizeShopCode } from "./_data";

export const runtime = "nodejs";
export const alt = "Scan to pay with Rove";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  const res = await loadShop(normalizeShopCode(merchantId)).catch(() => null);
  const name = res?.kind === "ok" ? res.shop.name : "Pay with Rove";
  const verified = res?.kind === "ok" && res.shop.verified;

  return ogCard({
    eyebrow: "Shop QR",
    headline: name,
    detail: "Pick from the menu or type an amount",
    status: { label: "Scan to pay", tone: "neutral", icon: "none" },
    footer: "Apple Pay · Card · BNB Chain",
    verified,
  });
}
