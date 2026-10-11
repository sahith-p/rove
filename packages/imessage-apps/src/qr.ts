// QR images the agent sends: plain QR, one-time payment QR (with the typed code under it),
// and the printable shop sticker. Owner: Sahith (task SH-B6).
//
// We build an SVG ourselves (QR modules drawn as <rect>s from the qrcode matrix) and render it to
// PNG with resvg. Text uses system fonts; if a host has none, the QR still renders and scans.
import QRCode from "qrcode";
import { renderAsync } from "@resvg/resvg-js";

const SANS = "Helvetica, Arial, sans-serif";
const MONO = "Menlo, 'SF Mono', 'DejaVu Sans Mono', 'Courier New', monospace";
const INK = "#111111";
const MUTED = "#555555";
const GREEN = "#0a7d3b";
const QUIET_MODULES = 4;

// ---------- helpers ----------

/** Escape user text for SVG text content and attribute values. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * QR symbol as SVG <rect>s (one per horizontal run of dark modules) centered in a square box of
 * `box` px at (x, y). The box includes a quiet zone of at least 4 modules; module size is an
 * integer number of px so edges stay crisp.
 */
function qrGroup(url: string, x: number, y: number, box: number): string {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const unit = Math.max(1, Math.floor(box / (n + QUIET_MODULES * 2)));
  const ox = Math.round(x + (box - n * unit) / 2);
  const oy = Math.round(y + (box - n * unit) / 2);
  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!modules.get(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && modules.get(r, c)) c++;
      rects.push(
        `<rect x="${ox + start * unit}" y="${oy + r * unit}" width="${(c - start) * unit}" height="${unit}"/>`,
      );
    }
  }
  return `<g fill="#000000" shape-rendering="crispEdges">${rects.join("")}</g>`;
}

/** Smallest box that still gives `minUnit` px modules plus the quiet zone. */
function qrMinBox(url: string, minUnit: number): number {
  const n = QRCode.create(url, { errorCorrectionLevel: "M" }).modules.size;
  return (n + QUIET_MODULES * 2) * minUnit;
}

/** Rough rendered width of `text` in a sans font (conservative, so text never overflows). */
function textWidth(text: string, fontSize: number, bold = false): number {
  return [...text].length * fontSize * (bold ? 0.64 : 0.58);
}

/** Font size ≤ `max` (≥ `min`) at which `text` fits in `width`. */
function fitSize(text: string, width: number, max: number, min: number, bold = false): number {
  let size = max;
  while (size > min && textWidth(text, size, bold) > width) size -= 2;
  return size;
}

function textEl(
  text: string,
  x: number,
  y: number,
  size: number,
  opts: { weight?: number; fill?: string; family?: string } = {},
): string {
  return (
    `<text x="${x}" y="${y}" font-family="${esc(opts.family ?? SANS)}" font-size="${size}" ` +
    `font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? INK}" text-anchor="middle">${esc(text)}</text>`
  );
}

/** Greedy word wrap; words longer than a line are hard-broken. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while ([...word].length > maxChars) {
      if (line) {
        lines.push(line);
        line = "";
      }
      const chars = [...word];
      lines.push(chars.slice(0, maxChars).join(""));
      word = chars.slice(maxChars).join("");
    }
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= maxChars) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Largest font size (and its lines) at which bold `text` wraps into ≤ `maxLines` lines of `width`
 * whose stacked height fits in `height`. Truncates with an ellipsis only as a last resort.
 */
function fitWrapped(
  text: string,
  width: number,
  height: number,
  max: number,
  min: number,
  maxLines: number,
): { size: number; lines: string[] } {
  const perLine = (size: number) => Math.max(1, Math.floor(width / (size * 0.6)));
  for (let size = max; size >= min; size -= 4) {
    const lines = wrap(text, perLine(size));
    if (lines.length <= maxLines && lines.length * size * 1.12 <= height) return { size, lines };
  }
  const lines = wrap(text, perLine(min));
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/.$/u, "")}…`;
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
  const img = await renderAsync(svg, {
    background: "#ffffff",
    fitTo: { mode: "original" },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica", sansSerifFamily: "Helvetica" },
    logLevel: "off",
  });
  return new Uint8Array(img.asPng());
}

// ---------- public API ----------

/** Plain QR code PNG (error correction M, ≥ 4-module quiet zone). Default 1024 px square. */
export async function qrPng(url: string, opts: { size?: number } = {}): Promise<Uint8Array> {
  const size = Math.max(opts.size ?? 1024, qrMinBox(url, 1));
  return toPng(svgDoc(size, size, qrGroup(url, 0, 0, size)));
}

/**
 * One-time payment QR (~1080×1400): optional shop name, the QR, the typed code in big spaced
 * letters (customers can scan OR text it), then amount, expiry and a how-to line.
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

  if (input.title) {
    const size = fitSize(input.title, W - 120, 60, 32, true);
    parts.push(textEl(input.title, cx, 108, size, { weight: 700 }));
  }

  const qrBox = Math.max(780, qrMinBox(input.url, 4));
  parts.push(qrGroup(input.url, (W - qrBox) / 2, 150, qrBox));

  // Code: each character centered in its own cell, so spacing is even regardless of the font.
  const chars = [...input.code.trim()];
  const cell = Math.min(128, Math.floor((W - 160) / Math.max(1, chars.length)));
  const codeW = cell * chars.length;
  const codeX = (W - codeW) / 2;
  const codeY = 960;
  parts.push(
    `<rect x="${codeX - 24}" y="${codeY}" width="${codeW + 48}" height="150" rx="24" fill="#f2f2f2"/>`,
  );
  chars.forEach((ch, i) => {
    parts.push(
      textEl(ch, codeX + cell * i + cell / 2, codeY + 112, Math.round(cell * 0.92), {
        weight: 700,
        family: MONO,
      }),
    );
  });

  let y = 1190;
  if (input.amountText) {
    parts.push(textEl(input.amountText, cx, y, fitSize(input.amountText, W - 120, 64, 32, true), { weight: 700 }));
    y += 70;
  }
  if (input.expiresText) {
    parts.push(textEl(input.expiresText, cx, y, fitSize(input.expiresText, W - 120, 38, 24), { fill: MUTED }));
    y += 56;
  }
  parts.push(textEl("Scan to pay, or text this code to Rove", cx, Math.max(y, 1330), 36, { fill: MUTED }));

  return toPng(svgDoc(W, H, parts.join("")));
}

/**
 * Printable shop sticker (~1200×1600): shop name, a large QR to the shop page, the XRPL verified
 * badge, and how to pay by text (`pay <shopCode>`).
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
    `<rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="48" fill="none" stroke="#d0d0d0" stroke-width="4"/>`,
  );

  // Shop name: biggest size that fits the 300px band, wrapping to ≤ 3 lines for long names.
  const name = input.name.trim() || "Shop";
  const { size, lines } = fitWrapped(name, W - 180, 300, 120, 48, 3);
  const lineH = Math.round(size * 1.12);
  const nameTop = 70 + (300 - lineH * lines.length) / 2;
  lines.forEach((line, i) => {
    parts.push(textEl(line, cx, Math.round(nameTop + lineH * (i + 0.8)), size, { weight: 800 }));
  });

  const qrBox = Math.max(900, qrMinBox(input.url, 6));
  parts.push(qrGroup(input.url, (W - qrBox) / 2, 380, qrBox));

  let y = 1350;
  if (input.verified) {
    const label = "Verified on XRPL";
    const fs = 46;
    const iconR = 26;
    const gap = 18;
    // Center icon + label as one unit; label width is an estimate, so anchor the label at its
    // own center and hang the icon off its estimated left edge.
    const labelW = [...label].length * fs * 0.53;
    const labelCx = cx + (iconR * 2 + gap) / 2;
    const icx = labelCx - labelW / 2 - gap - iconR;
    const icy = y - 16;
    parts.push(
      `<circle cx="${icx}" cy="${icy}" r="${iconR}" fill="${GREEN}"/>` +
        `<path d="M ${icx - 12} ${icy + 1} L ${icx - 3} ${icy + 10} L ${icx + 13} ${icy - 9}" ` +
        `fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    parts.push(textEl(label, labelCx, y, fs, { weight: 700, fill: GREEN }));
    y += 90;
  } else {
    y += 30;
  }

  parts.push(textEl("Scan to pay · Apple Pay", cx, y, 52, { weight: 700 }));
  y += 76;
  const textLine = `Or text "pay ${input.shopCode}" to ${input.roveNumber ?? "Rove"}`;
  parts.push(textEl(textLine, cx, y, fitSize(textLine, W - 140, 44, 24), { fill: MUTED }));

  return toPng(svgDoc(W, H, parts.join("")));
}
