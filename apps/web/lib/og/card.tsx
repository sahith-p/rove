// SERVER ONLY (Node runtime). One 1200×630 layout for every card page's static preview (SH-B3).
// Messages shows this image when it can't render the iMessage App live, so it has to read at a glance:
// wordmark + status pill on top, a big amount or headline, one line of detail, merchant on the footer.
// Same rules as the web UI: one surface color, hairlines in one neutral border color, pure neutral grays (R=G=B),
// color only for meaning (green = paid/done, red = failed, amber = pending), Faculty Glyphic for the wordmark and
// the hero line, Geist for text, Geist Mono for codes. No orange.
// Satori rules: every multi-child <div> needs display:flex; no glyph that the fonts may lack (the ✓ is an SVG).
import { ImageResponse } from "next/og";
import { ogFonts } from "./fonts";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

export type OgTone = "success" | "pending" | "error" | "neutral";
export type OgIcon = "check" | "dot" | "lock" | "none";

export interface OgCardInput {
  /** Small line above the headline ("Ah Seng Chicken Rice", "Receipt"). Drawn as an uppercase mono label. */
  eyebrow?: string;
  /** Big line: an amount ("S$12.50": the currency prefix is drawn smaller) or a short headline. */
  headline: string;
  /** true → headline is a formatted amount; its non-numeric prefix ("S$", "US$") is drawn smaller and muted. */
  amount?: boolean;
  /** One line under the headline ("2× Chicken rice, 1× Barley drink"). Truncated with an ellipsis. */
  detail?: string;
  status?: { label: string; tone: OgTone; icon?: OgIcon };
  /** Footer left (merchant / destination). */
  footer?: string;
  /** Show a small "verified" check next to the footer. */
  verified?: boolean;
  /** Footer right, monospace (invoice code, reference). */
  meta?: string;
  dark?: boolean;
}

// Pure neutral grays only (R=G=B), matching app/globals.css.
const LIGHT = { bg: "#ffffff", text: "#0a0a0a", muted: "#737373", line: "#e5e5e5" };
const DARK = { bg: "#0a0a0a", text: "#fafafa", muted: "#a3a3a3", line: "#262626" };

/** The one meaning color per tone (dot / check / label). Neutral stays gray. */
const TONE_COLOR: Record<OgTone, { light: string; dark: string }> = {
  success: { light: "#15803d", dark: "#4ade80" },
  pending: { light: "#b45309", dark: "#fbbf24" },
  error: { light: "#dc2626", dark: "#f87171" },
  neutral: { light: "#737373", dark: "#a3a3a3" },
};

function clip(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}

/** Headline size steps down with length so long words never wrap off the card. */
function headlineSize(text: string, amount: boolean): number {
  const n = Array.from(text).length;
  if (amount) return n <= 8 ? 184 : n <= 11 ? 160 : n <= 14 ? 132 : 108;
  return n <= 10 ? 132 : n <= 16 ? 108 : n <= 22 ? 90 : 74;
}

function splitAmount(text: string): { prefix: string; value: string } {
  const m = /^([^\d-]*)(.*)$/.exec(text);
  return { prefix: m?.[1] ?? "", value: m?.[2] ?? text };
}

function Icon({ kind, color, size }: { kind: OgIcon; color: string; size: number }) {
  if (kind === "check") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "lock") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke={color} strokeWidth={1.8} />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "dot") {
    return <div style={{ width: size * 0.36, height: size * 0.36, borderRadius: 999, background: color }} />;
  }
  return null;
}

/** The status pill: hairline frame, meaning-colored dot or check, ink label (red label for errors). */
function Pill({ label, tone, icon, dark, c }: { label: string; tone: OgTone; icon?: OgIcon; dark: boolean; c: typeof LIGHT }) {
  const color = TONE_COLOR[tone][dark ? "dark" : "light"];
  const kind = icon ?? (tone === "success" ? "check" : "dot");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: kind === "none" ? "14px 30px" : "14px 30px 14px 22px",
        border: `2px solid ${c.line}`,
        borderRadius: 999,
        background: c.bg,
        color: tone === "error" ? color : tone === "neutral" ? c.muted : c.text,
        fontSize: 32,
        fontWeight: 600,
        letterSpacing: -0.3,
      }}
    >
      {kind !== "none" ? (
        <div style={{ display: "flex", width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
          <Icon kind={kind} color={kind === "lock" ? c.text : color} size={32} />
        </div>
      ) : null}
      <span>{clip(label, 28)}</span>
    </div>
  );
}

export async function ogCard(input: OgCardInput): Promise<ImageResponse> {
  const dark = input.dark ?? false;
  const c = dark ? DARK : LIGHT;
  const fonts = await ogFonts();
  const has = (name: string) => fonts.some((f) => f.name === name);
  const serif = has("Faculty Glyphic") ? "Faculty Glyphic" : undefined;
  const mono = has("Geist Mono") ? "Geist Mono" : undefined;
  const headline = clip(input.headline, 26);
  const size = headlineSize(headline, input.amount ?? false);
  const { prefix, value } = input.amount ? splitAmount(headline) : { prefix: "", value: headline };
  const success = TONE_COLOR.success[dark ? "dark" : "light"];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: c.bg,
          color: c.text,
          fontFamily: has("Geist") ? "Geist" : undefined,
          padding: "60px 80px 56px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72 }}>
          {/* Wordmark: "Rove" in the display serif, near-black (same as app/icon.png). */}
          <span style={{ fontFamily: serif, fontSize: 52, fontWeight: 400, letterSpacing: -0.5, color: c.text }}>Rove</span>
          {input.status ? <Pill {...input.status} dark={dark} c={c} /> : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1, paddingBottom: 8 }}>
          {input.eyebrow ? (
            <div
              style={{
                display: "flex",
                fontFamily: mono,
                fontSize: 26,
                fontWeight: 500,
                color: c.muted,
                letterSpacing: 3,
                textTransform: "uppercase",
                marginBottom: 18,
              }}
            >
              {clip(input.eyebrow, 40)}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              fontFamily: serif,
              fontSize: size,
              fontWeight: 400,
              letterSpacing: -size * 0.025,
              lineHeight: 1,
              color: c.text,
            }}
          >
            {prefix ? (
              <span style={{ fontSize: size * 0.5, color: c.muted, marginRight: size * 0.06, letterSpacing: -size * 0.005 }}>{prefix}</span>
            ) : null}
            <span>{value}</span>
          </div>
          {input.detail ? (
            <div style={{ display: "flex", fontSize: 34, fontWeight: 400, color: c.muted, marginTop: 22, letterSpacing: -0.3 }}>
              {clip(input.detail, 56)}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `2px solid ${c.line}`,
            paddingTop: 28,
            minHeight: 72,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 600, letterSpacing: -0.4, color: c.text }}>
            <span>{clip(input.footer ?? "Pay and get paid in a text thread", 44)}</span>
            {input.verified ? (
              <div
                style={{
                  display: "flex",
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: `2px solid ${success}`,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon kind="check" color={success} size={20} />
              </div>
            ) : null}
          </div>
          {input.meta ? (
            <div
              style={{
                display: "flex",
                padding: "8px 16px",
                border: `2px solid ${c.line}`,
                borderRadius: 12,
                fontFamily: mono,
                fontSize: 26,
                fontWeight: 500,
                color: c.text,
                letterSpacing: 3,
              }}
            >
              {clip(input.meta, 28)}
            </div>
          ) : null}
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
