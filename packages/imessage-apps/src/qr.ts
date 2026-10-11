// QR images the agent sends: plain QR, one-time payment QR (with the typed code under it),
// and the printable shop sticker. Owner: Sahith (tasks SH-B6, restyle follow-up).
//
// We build an SVG ourselves and render it to PNG with resvg. The QR is drawn from the qrcode
// matrix as round dots, with the three finder patterns ("eyes") and the alignment patterns drawn
// as smooth rounded-square paths instead of modules. Text is set in Geist / Geist Mono, bundled in
// `assets/fonts` (SIL OFL) and handed to resvg with system fonts off, so a bare Linux host renders
// exactly what a Mac does. Text widths are measured with resvg itself (same fonts), so centering,
// pills and fit-to-width are exact rather than estimated.
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { Resvg, renderAsync, type ResvgRenderOptions } from "@resvg/resvg-js";

const SANS = "Geist";
const MONO = "Geist Mono";
const INK = "#0a0a0a";
const MUTED = "#737373";
const ACCENT = "#0a0a0a"; // monochrome: eyes + wordmark dot in ink (no orange, no blue-tinted grays)
const CARD = "#f5f5f5";
const GREEN = "#16a34a";
const GREEN_INK = "#15803d";
const GREEN_BG = "#ecfdf3";
const QUIET_MODULES = 4;
/** Styled codes (dots + custom eyes) use Q (~25% recovery) to absorb the styling. */
const ECC = "Q" as const;
/** Dot diameter as a fraction of the module size. */
const DOT = 0.9;
/** Eye corner radius as a fraction of the eye's side. */
const EYE_RADIUS = 0.35;

// ---------- fonts ----------

let fontFiles: string[] | undefined;

/** Bundled font paths, resolved relative to this module (lazily, so importing never touches disk). */
function fonts(): string[] {
  fontFiles ??= [
    new URL("../assets/fonts/Geist-Regular.ttf", import.meta.url),
    new URL("../assets/fonts/Geist-SemiBold.ttf", import.meta.url),
    new URL("../assets/fonts/Geist-Bold.ttf", import.meta.url),
    new URL("../assets/fonts/GeistMono-Medium.ttf", import.meta.url),
    new URL("../assets/fonts/GeistMono-SemiBold.ttf", import.meta.url),
  ].map((u) => fileURLToPath(u));
  return fontFiles;
}

function resvgOptions(): ResvgRenderOptions {
  return {
    background: "#ffffff",
    fitTo: { mode: "original" },
    font: {
      fontFiles: fonts(),
      loadSystemFonts: false,
      defaultFontFamily: SANS,
      sansSerifFamily: SANS,
      monospaceFamily: MONO,
    },
    logLevel: "off",
  };
}

// ---------- helpers ----------

/** Escape user text for SVG text content and attribute values. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Round to 2 decimals for compact, stable SVG numbers. */
function n2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Rounded rectangle as a closed path (clockwise). */
function rrect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  const p = n2;
  return (
    `M${p(x + rr)} ${p(y)}H${p(x + w - rr)}A${p(rr)} ${p(rr)} 0 0 1 ${p(x + w)} ${p(y + rr)}` +
    `V${p(y + h - rr)}A${p(rr)} ${p(rr)} 0 0 1 ${p(x + w - rr)} ${p(y + h)}` +
    `H${p(x + rr)}A${p(rr)} ${p(rr)} 0 0 1 ${p(x)} ${p(y + h - rr)}` +
    `V${p(y + rr)}A${p(rr)} ${p(rr)} 0 0 1 ${p(x + rr)} ${p(y)}Z`
  );
}

/** Rounded-square ring of `size` with a `stroke`-wide band, plus a rounded-square pupil inside. */
function eye(x: number, y: number, size: number, stroke: number, pupil: number): { ring: string; pupil: string } {
  const r = size * EYE_RADIUS;
  const ring = rrect(x, y, size, size, r) + rrect(x + stroke, y + stroke, size - 2 * stroke, size - 2 * stroke, r - stroke);
  const off = (size - pupil) / 2;
  return { ring, pupil: rrect(x + off, y + off, pupil, pupil, pupil * EYE_RADIUS) };
}

/** Centers (row/col) of the alignment patterns for a symbol of `n` modules (ISO 18004 Annex E). */
function alignmentCenters(n: number): Array<[number, number]> {
  const version = (n - 17) / 4;
  if (version < 2) return [];
  const count = Math.floor(version / 7) + 2;
  const step = n === 145 ? 26 : Math.ceil((n - 13) / (2 * count - 2)) * 2;
  const pos = [n - 7];
  for (let i = 1; i < count - 1; i++) pos.push(pos[i - 1]! - step);
  pos.push(6);
  pos.reverse();
  const out: Array<[number, number]> = [];
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      // The three corners taken by the finder patterns have no alignment pattern.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      out.push([pos[i]!, pos[j]!]);
    }
  }
  return out;
}

function symbol(url: string) {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: ECC });
  return modules;
}

/**
 * Styled QR symbol centered in a square box of `box` px at (x, y). The box includes a quiet zone
 * of at least 4 modules; module size is a whole number of px. Data modules are dots; finder and
 * alignment patterns are drawn as rounded-square paths (and their modules are skipped). With
 * `card`, the box itself is painted as a rounded card behind the code.
 */
function qrGroup(url: string, x: number, y: number, box: number, card?: { fill: string; radius: number }): string {
  const modules = symbol(url);
  const n = modules.size;
  const u = Math.max(1, Math.floor(box / (n + QUIET_MODULES * 2)));
  const ox = Math.round(x + (box - n * u) / 2);
  const oy = Math.round(y + (box - n * u) / 2);

  const skip = new Uint8Array(n * n);
  const block = (r0: number, c0: number, size: number) => {
    for (let r = r0; r < r0 + size; r++) for (let c = c0; c < c0 + size; c++) skip[r * n + c] = 1;
  };
  // Finder patterns plus their separators (always light) are drawn as eyes.
  block(0, 0, 8);
  block(0, n - 8, 8);
  block(n - 8, 0, 8);
  const aligns = alignmentCenters(n);
  for (const [r, c] of aligns) block(r - 2, c - 2, 5);

  const rad = (u * DOT) / 2;
  const dots: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (skip[r * n + c] || !modules.get(r, c)) continue;
      const cx = ox + c * u + u / 2;
      const cy = oy + r * u + u / 2;
      // A circle as two arcs: one compact subpath per dot, all in a single <path>.
      dots.push(`M${n2(cx - rad)} ${n2(cy)}a${n2(rad)} ${n2(rad)} 0 1 0 ${n2(2 * rad)} 0a${n2(rad)} ${n2(rad)} 0 1 0 ${n2(-2 * rad)} 0`);
    }
  }

  const rings: string[] = [];
  const pupils: string[] = [];
  for (const [r, c] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    const e = eye(ox + c * u, oy + r * u, 7 * u, u, 3 * u);
    rings.push(e.ring);
    pupils.push(e.pupil);
  }
  const small: string[] = [];
  for (const [r, c] of aligns) {
    const e = eye(ox + (c - 2) * u, oy + (r - 2) * u, 5 * u, u, u * 1.1);
    small.push(e.ring, e.pupil);
  }

  const bg = card ? `<rect x="${n2(x)}" y="${n2(y)}" width="${box}" height="${box}" rx="${card.radius}" fill="${card.fill}"/>` : "";
  return (
    bg +
    `<path fill="${INK}" d="${dots.join("")}"/>` +
    (small.length ? `<path fill="${INK}" fill-rule="evenodd" d="${small.join("")}"/>` : "") +
    `<path fill="${ACCENT}" fill-rule="evenodd" d="${rings.join("")}"/>` +
    `<path fill="${ACCENT}" d="${pupils.join("")}"/>`
  );
}

/** Smallest box that still gives `minUnit` px modules plus the quiet zone. */
function qrMinBox(url: string, minUnit: number): number {
  return (symbol(url).size + QUIET_MODULES * 2) * minUnit;
}

// ---------- text ----------

/** A run of text with its own font settings (lets one line mix Geist and Geist Mono). */
type Run = { text: string; family?: string; weight?: number; fill?: string };
type TextStyle = { weight?: number; fill?: string; family?: string; /** em */ tracking?: number };

function runsMarkup(runs: Run[]): string {
  return runs
    .map((r) => {
      const attrs =
        (r.family ? ` font-family="${esc(r.family)}"` : "") +
        (r.weight ? ` font-weight="${r.weight}"` : "") +
        (r.fill ? ` fill="${r.fill}"` : "");
      return attrs ? `<tspan${attrs}>${esc(r.text)}</tspan>` : esc(r.text);
    })
    .join("");
}

function textAttrs(size: number, s: TextStyle): string {
  return (
    `font-family="${esc(s.family ?? SANS)}" font-size="${n2(size)}" font-weight="${s.weight ?? 400}"` +
    (s.tracking ? ` letter-spacing="${n2(s.tracking * size)}"` : "")
  );
}

const widthCache = new Map<string, number>();

/** Rendered (ink) width of `runs` at `size` px, measured by resvg with the bundled fonts. */
function measure(runs: Run[] | string, size: number, style: TextStyle = {}): number {
  const rs = typeof runs === "string" ? [{ text: runs }] : runs;
  const key = JSON.stringify([rs, style]);
  let w100 = widthCache.get(key);
  if (w100 === undefined) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="200">` +
      `<text x="100" y="150" ${textAttrs(100, style)}>${runsMarkup(rs)}</text></svg>`;
    w100 = new Resvg(svg, resvgOptions()).getBBox()?.width ?? 0;
    if (widthCache.size >= 4000) widthCache.clear(); // bounded: the agent process is long-lived
    widthCache.set(key, w100);
  }
  return (w100 * size) / 100;
}

/** Centered text line at baseline y. */
function textEl(runs: Run[] | string, x: number, y: number, size: number, style: TextStyle = {}): string {
  const rs = typeof runs === "string" ? [{ text: runs }] : runs;
  return (
    `<text x="${n2(x)}" y="${n2(y)}" ${textAttrs(size, style)} fill="${style.fill ?? INK}" ` +
    `text-anchor="middle">${runsMarkup(rs)}</text>`
  );
}

/** Drop characters from the end (adding "…") until `text` fits `width` at `size`. */
function ellipsize(text: string, width: number, size: number, style: TextStyle): string {
  if (measure(text, size, style) <= width) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`, size, style) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join("").trimEnd()}…`;
}

/** Largest size in [min, max] at which `text` fits `width` on one line (ellipsized at `min`). */
function fitLine(text: string, width: number, max: number, min: number, style: TextStyle = {}): { size: number; text: string } {
  const w = measure(text, 100, style);
  const size = Math.max(min, Math.min(max, Math.floor((width / Math.max(w, 1)) * 100)));
  return { size, text: size === min ? ellipsize(text, width, min, style) : text };
}

/** Greedy word wrap by measured width; words longer than a line are hard-broken. */
function wrap(text: string, width: number, size: number, style: TextStyle): string[] {
  const fits = (s: string) => measure(s, size, style) <= width;
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (!fits(word)) {
      // Longest prefix that fits (at least one character), by binary search.
      const chars = [...word];
      let k = 1;
      let hi = chars.length - 1;
      while (k < hi) {
        const mid = Math.ceil((k + hi) / 2);
        if (fits(chars.slice(0, mid).join(""))) k = mid;
        else hi = mid - 1;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(chars.slice(0, k).join(""));
      word = chars.slice(k).join("");
    }
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Largest font size (and its lines) at which `text` wraps into ≤ `maxLines` lines of `width`
 * whose stacked height fits in `height`. Truncates with an ellipsis only as a last resort.
 */
function fitWrapped(
  text: string,
  width: number,
  height: number,
  max: number,
  min: number,
  maxLines: number,
  style: TextStyle,
  lineHeight: number,
): { size: number; lines: string[] } {
  for (let size = max; size >= min; size -= 4) {
    const lines = wrap(text, width, size, style);
    if (lines.length <= maxLines && lines.length * size * lineHeight <= height) {
      // Balance the lines: narrowest width that still wraps into the same number of lines, so
      // "Ah Seng Chicken / Rice" becomes "Ah Seng / Chicken Rice".
      let lo = 0;
      let hi = width;
      for (let i = 0; i < 12 && lines.length > 1; i++) {
        const mid = (lo + hi) / 2;
        if (wrap(text, mid, size, style).length === lines.length) hi = mid;
        else lo = mid;
      }
      return { size, lines: lines.length > 1 ? wrap(text, hi, size, style) : lines };
    }
  }
  const lines = wrap(text, width, min, style);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = ellipsize(`${lines[maxLines - 1]!}…`, width, min, style);
  }
  return { size: min, lines };
}

function svgDoc(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>${body}</svg>`
  );
}

async function toPng(svg: string): Promise<Uint8Array> {
  const img = await renderAsync(svg, resvgOptions());
  return new Uint8Array(img.asPng());
}

/** Geist cap height in em: baseline offset that optically centers capitals on a line's middle. */
const CAP = 0.71;

// ---------- public API ----------

/** Styled QR code PNG on white (error correction Q, ≥ 4-module quiet zone). Default 1024 px square. */
export async function qrPng(url: string, opts: { size?: number } = {}): Promise<Uint8Array> {
  const size = Math.max(opts.size ?? 1024, qrMinBox(url, 1));
  return toPng(svgDoc(size, size, qrGroup(url, 0, 0, size)));
}

/**
 * One-time payment QR (~1080×1400): optional shop name, the QR on a soft card, the typed code in
 * a pill (customers can scan OR text it), then amount, expiry and a how-to line.
 */
export async function codeQrPng(input: {
  url: string;
  code: string;
  title?: string;
  amountText?: string;
  expiresText?: string;
}): Promise<Uint8Array> {
  const W = 1080;
  const H = 1400;
  const cx = W / 2;
  const parts: string[] = [];

  if (input.title?.trim()) {
    const style: TextStyle = { weight: 600, tracking: -0.02 };
    const t = fitLine(input.title.trim(), W - 160, 56, 32, style);
    parts.push(textEl(t.text, cx, 104, t.size, style));
  }

  const qrBox = Math.max(740, qrMinBox(input.url, 4));
  parts.push(qrGroup(input.url, (W - qrBox) / 2, 150, qrBox, { fill: CARD, radius: 64 }));

  // Code: each character centered in its own cell, so tracking is wide and even.
  const chars = [...input.code.trim()];
  const fs = Math.min(84, Math.floor((W - 260) / Math.max(1, chars.length) / 1.05));
  const cell = Math.round(fs * 1.05);
  const codeW = cell * chars.length;
  const pillH = 132;
  const pillW = codeW + 112;
  const pillY = 150 + qrBox + 40;
  parts.push(`<rect x="${n2(cx - pillW / 2)}" y="${pillY}" width="${n2(pillW)}" height="${pillH}" rx="${pillH / 2}" fill="${INK}"/>`);
  const codeX = cx - codeW / 2;
  chars.forEach((ch, i) => {
    parts.push(
      textEl(ch, codeX + cell * i + cell / 2, pillY + pillH / 2 + (fs * CAP) / 2, fs, {
        weight: 600,
        family: MONO,
        fill: "#ffffff",
      }),
    );
  });

  let y = pillY + pillH + 100;
  if (input.amountText) {
    const style: TextStyle = { weight: 700, tracking: -0.02 };
    const t = fitLine(input.amountText, W - 160, 68, 32, style);
    parts.push(textEl(t.text, cx, y, t.size, style));
    y += 62;
  }
  if (input.expiresText) {
    const t = fitLine(input.expiresText, W - 160, 34, 24);
    parts.push(textEl(t.text, cx, y, t.size, { fill: MUTED }));
    y += 52;
  }
  parts.push(textEl("Scan to pay, or text this code to Rove", cx, Math.max(y, H - 60), 30, { fill: MUTED }));

  return toPng(svgDoc(W, H, parts.join("")));
}

/**
 * Printable shop sticker (~1200×1600): shop name, a large QR card to the shop page, the XRPL
 * verified badge, how to pay by text (`pay <shopCode>`), a dashed cut line and the Rove wordmark.
 */
export async function stickerPng(input: {
  name: string;
  url: string;
  shopCode: string;
  roveNumber?: string;
  verified: boolean;
}): Promise<Uint8Array> {
  const W = 1200;
  const H = 1600;
  const cx = W / 2;
  const parts: string[] = [];

  // Cut line.
  parts.push(
    `<rect x="28" y="28" width="${W - 56}" height="${H - 56}" rx="72" fill="none" stroke="#d4d4d4" ` +
      `stroke-width="4" stroke-dasharray="22 16" stroke-linecap="round"/>`,
  );

  // Shop name: biggest size that fits the band, wrapping to ≤ 3 lines for long names.
  const name = input.name.trim() || "Shop";
  const nameStyle: TextStyle = { weight: 700, tracking: -0.03 };
  const bandTop = 92;
  const bandH = 236;
  const lineH = 1.08;
  const { size, lines } = fitWrapped(name, W - 220, bandH, 116, 44, 3, nameStyle, lineH);
  const step = size * lineH;
  // Center the block of cap heights in the band.
  const firstBaseline = bandTop + (bandH - (step * (lines.length - 1) + size * CAP)) / 2 + size * CAP;
  lines.forEach((line, i) => parts.push(textEl(line, cx, firstBaseline + step * i, size, nameStyle)));

  const qrTop = 356;
  const qrBox = Math.max(800, qrMinBox(input.url, 6));
  parts.push(qrGroup(input.url, (W - qrBox) / 2, qrTop, qrBox, { fill: CARD, radius: 72 }));

  // Footer block, centered between the card and the wordmark.
  const scanSize = 54;
  const lineSize = 38;
  const badgeH = 72;
  const gapBadge = 56;
  const gapLine = 34;
  const blockH = (input.verified ? badgeH + gapBadge : 0) + scanSize * CAP + gapLine + lineSize * CAP;
  const regionTop = qrTop + qrBox;
  const regionBottom = 1468;
  let y = regionTop + (regionBottom - regionTop - blockH) / 2;

  if (input.verified) {
    const label = "Verified on XRPL";
    const ls: TextStyle = { weight: 600, fill: GREEN_INK };
    const fs = 34;
    const iconR = 20;
    const gap = 14;
    const pad = 28;
    const labelW = measure(label, fs, ls);
    const pillW = pad + iconR * 2 + gap + labelW + pad + 4;
    const px = cx - pillW / 2;
    const midY = y + badgeH / 2;
    const icx = px + pad + iconR;
    parts.push(
      `<rect x="${n2(px)}" y="${n2(y)}" width="${n2(pillW)}" height="${badgeH}" rx="${badgeH / 2}" fill="${GREEN_BG}" stroke="#bbf7d0" stroke-width="2"/>` +
        `<circle cx="${n2(icx)}" cy="${n2(midY)}" r="${iconR}" fill="${GREEN}"/>` +
        `<path d="M${n2(icx - 8.5)} ${n2(midY + 0.5)}L${n2(icx - 2.5)} ${n2(midY + 6.5)}L${n2(icx + 9)} ${n2(midY - 6)}" ` +
        `fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    const labelX = icx + iconR + gap + labelW / 2;
    parts.push(textEl(label, labelX, midY + (fs * CAP) / 2, fs, ls));
    y += badgeH + gapBadge;
  }

  y += scanSize * CAP;
  parts.push(textEl("Scan to pay · Apple Pay", cx, y, scanSize, { weight: 600, tracking: -0.02 }));
  y += gapLine + lineSize * CAP;

  const runs: Run[] = [
    { text: 'Or text "pay ' },
    { text: input.shopCode, family: MONO, weight: 500, fill: INK },
    { text: `" to ${input.roveNumber ?? "Rove"}` },
  ];
  const maxW = W - 200;
  const lineFs = Math.max(24, Math.min(lineSize, Math.floor((maxW / Math.max(1, measure(runs, 100))) * 100)));
  parts.push(textEl(runs, cx, y, lineFs, { fill: MUTED }));

  // Wordmark.
  const mark = "Rove";
  const markFs = 30;
  const markStyle: TextStyle = { weight: 700, tracking: -0.02 };
  const markW = measure(mark, markFs, markStyle);
  const dotR = 7;
  const markY = 1530;
  const groupW = dotR * 2 + 10 + markW;
  const gx = cx - groupW / 2;
  parts.push(
    `<circle cx="${n2(gx + dotR)}" cy="${n2(markY - (markFs * CAP) / 2)}" r="${dotR}" fill="${ACCENT}"/>` +
      textEl(mark, gx + dotR * 2 + 10 + markW / 2, markY, markFs, markStyle),
  );

  return toPng(svgDoc(W, H, parts.join("")));
}
