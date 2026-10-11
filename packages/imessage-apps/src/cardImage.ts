// The picture on a static Rove card bubble (customizedMiniApp layout.image): a white square with the title in the
// serif, the amount large in Geist and the status line. iMessage wants JPEG, so resvg renders RGBA and jpeg-js encodes.
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import type { CardLayout } from "@rove/shared";

const W = 600;
const H = 600;
const INK = "#0a0a0a";
const MUTED = "#737373";
const LINE = "#e5e5e5";

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

/** Title (caption), hero (trailingCaption, usually the amount), footer (trailingSubcaption or "Tap to open"). */
export function cardImageSvg(layout: CardLayout): string {
  const title = clip(layout.caption ?? "Rove", 26);
  const hero = layout.trailingCaption ?? "";
  const footer = layout.trailingSubcaption ?? (hero ? "Tap to pay" : "Tap to open");
  const heroSize = hero.length > 9 ? 92 : 112;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="48" y="96" font-family="Faculty Glyphic" font-size="40" fill="${INK}">${esc(title)}</text>
  ${hero ? `<text x="48" y="${H / 2 + heroSize / 3}" font-family="Geist" font-weight="600" font-size="${heroSize}" letter-spacing="-3" fill="${INK}">${esc(hero)}</text>` : ""}
  <line x1="48" y1="${H - 120}" x2="${W - 48}" y2="${H - 120}" stroke="${LINE}" stroke-width="2"/>
  <text x="48" y="${H - 62}" font-family="Geist" font-weight="500" font-size="30" fill="${MUTED}">${esc(footer)}</text>
  <text x="${W - 48}" y="${H - 62}" text-anchor="end" font-family="Faculty Glyphic" font-size="34" fill="${INK}">Rove</text>
</svg>`;
}

/** JPEG bytes for layout.image. */
export function cardImageJpeg(layout: CardLayout): Uint8Array<ArrayBuffer> {
  const r = new Resvg(cardImageSvg(layout), {
    background: "#ffffff",
    fitTo: { mode: "original" },
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Geist" },
    logLevel: "off",
  }).render();
  const out = jpeg.encode({ data: Buffer.from(r.pixels), width: r.width, height: r.height }, 90);
  return new Uint8Array(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength) as ArrayBuffer);
}
