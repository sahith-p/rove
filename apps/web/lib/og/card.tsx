// SERVER ONLY (Node runtime). One premium 1200×630 layout for every card page's static preview (SH-B3).
// Messages shows this image when it can't render the iMessage App live, so it has to read at a glance:
// wordmark + status pill on top, a big amount or headline, one line of detail, merchant on the footer.
// Satori rules: every multi-child <div> needs display:flex; no glyph that Geist may lack (the ✓ is an SVG).
import { ImageResponse } from "next/og";
import { ogFonts } from "./fonts";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

export type OgTone = "success" | "pending" | "error" | "neutral";
export type OgIcon = "check" | "dot" | "lock" | "none";

export interface OgCardInput {
  /** Small line above the headline ("Ah Seng Chicken Rice", "Receipt"). */
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

const LIGHT = {
  bg: "#ffffff",
  text: "#0b0b0c",
  muted: "#6b7280",
  faint: "#a1a1aa",
  rule: "#ececee",
  accent: "#ea580c",
  glow: "rgba(234, 88, 12, 0.13)",
};
const DARK = {
  bg: "#0b0b0c",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  faint: "#71717a",
  rule: "#27272a",
  accent: "#fb923c",
  glow: "rgba(251, 146, 60, 0.14)",
};

const TONES: Record<OgTone, { light: [string, string]; dark: [string, string] }> = {
  // [background, foreground]
  success: { light: ["#ecfdf3", "#15803d"], dark: ["#0c1f14", "#4ade80"] },
  pending: { light: ["#fffbeb", "#b45309"], dark: ["#2a1d08", "#fbbf24"] },
  error: { light: ["#fef2f2", "#b91c1c"], dark: ["#2a1111", "#f87171"] },
  neutral: { light: ["#f4f4f5", "#3f3f46"], dark: ["#1f1f23", "#d4d4d8"] },
};

function clip(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}

/** Headline size steps down with length so long words never wrap off the card. */
function headlineSize(text: string, amount: boolean): number {
  const n = Array.from(text).length;
  if (amount) return n <= 8 ? 176 : n <= 11 ? 156 : n <= 14 ? 128 : 104;
  return n <= 10 ? 136 : n <= 16 ? 112 : n <= 22 ? 92 : 76;
}

function splitAmount(text: string): { prefix: string; value: string } {
  const m = /^([^\d-]*)(.*)$/.exec(text);
  return { prefix: m?.[1] ?? "", value: m?.[2] ?? text };
}

function Icon({ kind, color, size }: { kind: OgIcon; color: string; size: number }) {
  if (kind === "check") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "lock") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="5" y="10.5" width="14" height="10" rx="2.5" fill={color} />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "dot") {
    return <div style={{ width: size * 0.5, height: size * 0.5, borderRadius: 999, background: color }} />;
  }
  return null;
}

/** The status pill, e.g. [✓ Paid]. */
function Pill({ label, tone, icon, dark }: { label: string; tone: OgTone; icon?: OgIcon; dark: boolean }) {
  const [bg, fg] = TONES[tone][dark ? "dark" : "light"];
  const kind = icon ?? (tone === "success" ? "check" : "dot");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: kind === "none" ? "16px 32px" : "16px 32px 16px 24px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 34,
        fontWeight: 600,
        letterSpacing: -0.4,
      }}
    >
      {kind !== "none" ? (
        <div style={{ display: "flex", width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
          <Icon kind={kind} color={fg} size={34} />
        </div>
      ) : null}
      <span>{clip(label, 28)}</span>
    </div>
  );
}

function Wordmark({ c }: { c: typeof LIGHT }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 22, height: 22, borderRadius: 999, background: c.accent }} />
      <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1.2, color: c.text }}>Rove</span>
    </div>
  );
}

export async function ogCard(input: OgCardInput): Promise<ImageResponse> {
  const dark = input.dark ?? false;
  const c = dark ? DARK : LIGHT;
  const fonts = await ogFonts();
  const headline = clip(input.headline, 26);
  const size = headlineSize(headline, input.amount ?? false);
  const { prefix, value } = input.amount ? splitAmount(headline) : { prefix: "", value: headline };

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          background: c.bg,
          color: c.text,
          fontFamily: fonts.length ? "Geist" : undefined,
          padding: "64px 80px 56px",
        }}
      >
        {/* soft brand glow, top right */}
        <div
          style={{
            position: "absolute",
            top: -380,
            right: -300,
            width: 900,
            height: 900,
            borderRadius: 999,
            background: `radial-gradient(circle at center, ${c.glow} 0%, rgba(0,0,0,0) 62%)`,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 70 }}>
          <Wordmark c={c} />
          {input.status ? <Pill {...input.status} dark={dark} /> : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1, paddingBottom: 8 }}>
          {input.eyebrow ? (
            <div style={{ display: "flex", fontSize: 38, fontWeight: 600, color: c.muted, letterSpacing: -0.6, marginBottom: 6 }}>
              {clip(input.eyebrow, 44)}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              fontSize: size,
              fontWeight: 700,
              letterSpacing: -size * 0.032,
              lineHeight: 1,
              color: c.text,
            }}
          >
            {prefix ? (
              <span style={{ fontSize: size * 0.56, color: c.muted, fontWeight: 600, marginRight: size * 0.04, letterSpacing: -size * 0.02 }}>
                {prefix}
              </span>
            ) : null}
            <span>{value}</span>
          </div>
          {input.detail ? (
            <div style={{ display: "flex", fontSize: 36, fontWeight: 400, color: c.muted, marginTop: 18 }}>
              {clip(input.detail, 56)}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `2px solid ${c.rule}`,
            paddingTop: 30,
            minHeight: 72,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 32, fontWeight: 600, letterSpacing: -0.4, color: c.text }}>
            <span>{clip(input.footer ?? "Pay and get paid in a text thread", 44)}</span>
            {input.verified ? (
              <div
                style={{
                  display: "flex",
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  background: c.accent,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon kind="check" color="#ffffff" size={20} />
              </div>
            ) : null}
          </div>
          {input.meta ? (
            <div
              style={{
                display: "flex",
                fontFamily: fonts.some((f) => f.name === "Geist Mono") ? "Geist Mono" : undefined,
                fontSize: 26,
                fontWeight: 500,
                color: c.faint,
                letterSpacing: 0.5,
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
