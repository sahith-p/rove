// OG / card preview image for /m/[merchantId]: shop name + "Scan to pay". Node runtime (reads the Geist font from disk).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { loadShop, normalizeShopCode } from "./_data";

export const runtime = "nodejs";
export const alt = "Scan to pay with Rove";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FONT_REL = "packages/imessage-apps/assets/fonts/Geist-SemiBold.ttf";

/** Geist SemiBold from the monorepo, or null (→ the default font) when it isn't on disk, e.g. in a traced deploy. */
async function geist(): Promise<ArrayBuffer | null> {
  for (const base of [path.join(process.cwd(), "../.."), process.cwd()]) {
    try {
      const buf = await readFile(path.join(base, FONT_REL));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      // try the next base
    }
  }
  return null;
}

export default async function Image({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  const [res, font] = await Promise.all([loadShop(normalizeShopCode(merchantId)).catch(() => null), geist()]);
  const name = res?.kind === "ok" ? res.shop.name : "Pay with Rove";
  const verified = res?.kind === "ok" && res.shop.verified;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "R";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "#ffffff",
          color: "#111827",
          fontFamily: font ? "Geist" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div
            style={{
              width: 112,
              height: 112,
              borderRadius: 32,
              background: "#f4f4f5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 56,
            }}
          >
            {initial}
          </div>
          {verified ? (
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 22px", borderRadius: 999, background: "#f0fdf4", color: "#16a34a", fontSize: 30 }}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
              Verified on XRPL
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: name.length > 24 ? 72 : 88, lineHeight: 1.05, letterSpacing: "-0.03em" }}>{name}</div>
          <div style={{ fontSize: 44, color: "#6b7280" }}>Pick from the menu or type an amount</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 30, color: "#6b7280" }}>
          <div style={{ display: "flex", padding: "14px 34px", borderRadius: 999, background: "#111827", color: "#ffffff", fontSize: 34 }}>
            Scan to pay
          </div>
          <div style={{ display: "flex" }}>Rove · settles on XRPL</div>
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Geist", data: font, weight: 600, style: "normal" }] : undefined },
  );
}
