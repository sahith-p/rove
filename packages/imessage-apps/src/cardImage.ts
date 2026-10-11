// The picture on a static Rove card bubble (customizedMiniApp layout.image): a dark square with the title in the
// serif and the amount large in Geist. iMessage wants JPEG, so resvg renders RGBA and jpeg-js encodes.
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import type { CardLayout } from "@rove/shared";

const W = 600;
const H = 600;
const BG = "#0a0a0a";
const FG = "#fafafa";
const SOFT = "#d4d4d4";
const DIM = "#737373";

let fontFiles: string[] | undefined;
function fonts(): string[] {
  fontFiles ??= ["Geist-Regular.ttf", "Geist-SemiBold.ttf", "FacultyGlyphic-Regular.ttf"].map((f) =>
    fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url)),
  );
  return fontFiles;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** True when the card reports money that already moved in (sale settled, receipt / invoice paid). */
export function isDone(layout: CardLayout): boolean {
  return /✓|^Paid|^Settled|^Received|^Money in/.test(layout.trailingSubcaption ?? "");
}

/**
 * Dark square: eyebrow (subcaption) in caps top-left, title (caption) in the serif, hero (trailingCaption, usually the
 * amount) large in Geist. Top-right is the Rove wordmark, or a light status chip ("✓ Paid", "✓ Money in") once money
 * has moved, so "you got paid" never looks like "please pay". The bottom band stays empty: iMessage overlays
 * layout.imageTitle there.
 */
export function cardImageSvg(layout: CardLayout): string {
  const done = isDone(layout);
  const eyebrow = (layout.subcaption ?? "").toUpperCase();
  const title = clip(layout.caption ?? "Rove", 24);
  const hero = layout.trailingCaption ?? "";
  const heroSize = hero.length > 10 ? 88 : hero.length > 8 ? 100 : 116;
  const heroY = 236 + 40 + heroSize;
  const chipText = (layout.trailingSubcaption ?? "").replace(/\s*✓\s*/g, "").trim() || "Paid";
  const chipW = 64 + chipText.length * 17;
  const chip = `<g transform="translate(${W - 52 - chipW} 48)">
    <rect width="${chipW}" height="60" rx="30" fill="${FG}"/>
    <path d="M24 30 l9 9 l17 -19" fill="none" stroke="${BG}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="58" y="40" font-family="Geist" font-weight="600" font-size="28" fill="${BG}">${esc(chipText)}</text>
  </g>`;
  const corner = done ? chip : `<text x="${W - 52}" y="92" text-anchor="end" font-family="Faculty Glyphic" font-size="34" fill="${DIM}">Rove</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${eyebrow ? `<text x="52" y="92" font-family="Geist" font-weight="600" font-size="24" letter-spacing="3" fill="${DIM}">${esc(eyebrow)}</text>` : ""}
  ${corner}
  <text x="52" y="236" font-family="Faculty Glyphic" font-size="42" fill="${SOFT}">${esc(title)}</text>
  ${hero ? `<text x="48" y="${heroY}" font-family="Geist" font-weight="600" font-size="${heroSize}" letter-spacing="-3" fill="${FG}">${esc(hero)}</text>` : ""}
</svg>`;
}

/** JPEG bytes for layout.image. */
export function cardImageJpeg(layout: CardLayout): Uint8Array<ArrayBuffer> {
  const r = new Resvg(cardImageSvg(layout), {
    background: BG,
    fitTo: { mode: "original" },
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Geist" },
    logLevel: "off",
  }).render();
  const out = jpeg.encode({ data: Buffer.from(r.pixels), width: r.width, height: r.height }, 90);
  return new Uint8Array(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength) as ArrayBuffer);
}
