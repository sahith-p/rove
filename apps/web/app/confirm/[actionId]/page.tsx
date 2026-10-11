// Merchant: confirm a pending refund / withdrawal / setting (button → POST /api/actions/:id/confirm)
// Owner: Sahith · Task: SH-B5 · Spec: docs/specs/imessage-apps.md, docs/specs/agent.md §5
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
//
// Server side only verifies the confirm token (Node runtime, TOKEN_SECRET) and hands the client the expiry.
// The confirm itself is the API's job: it re-verifies the token and claims the action atomically.
import type { Metadata } from "next";
import { verifyToken, type ConfirmTokenPayload } from "@rove/shared";
import { previewMetadata } from "../../../lib/og/metadata";
import { isCardMode } from "../../../lib/ui/card";
import { ConfirmClient, type InitialState } from "./ConfirmClient";
import { ExpiredView } from "./ExpiredView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return previewMetadata({
    title: "Confirm · Rove",
    description: "Confirm or cancel a request you made to Rove.",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  });
}

type Search = Record<string, string | string[] | undefined>;

const SUMMARY_MAX = 120;
const DEMO_TTL_MS = 5 * 60 * 1000;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Plain-text summary from `s`: decoded (tolerates double encoding and stray "%"), no control chars, ≤120 chars. */
function cleanSummary(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // Already decoded by Next and contains a literal "%": keep as is.
  }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const chars = Array.from(s); // don't split surrogate pairs (emoji) when truncating
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join("").trimEnd()}…` : s;
}

function verify(t: string | undefined, actionId: string, fixtures: boolean): ConfirmTokenPayload | null {
  if (!t) return null;
  const secret = process.env.TOKEN_SECRET;
  if (!secret) {
    if (!fixtures) console.error("[confirm] TOKEN_SECRET is not set");
    return null;
  }
  try {
    const payload = verifyToken<ConfirmTokenPayload>(t, secret);
    return payload && payload.actionId === actionId ? payload : null;
  } catch {
    return null; // malformed token
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ actionId: string }>;
  searchParams: Promise<Search>;
}) {
  const { actionId } = await params;
  const sp = await searchParams;
  const t = first(sp.t) ?? "";
  const summary = cleanSummary(first(sp.s));
  const fixtures = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

  const payload = verify(t, actionId, fixtures);
  const preview = fixtures ? first(sp.state) : undefined;

  if (preview === "expired" || (!payload && !fixtures)) {
    return <ExpiredView card={isCardMode(sp)} />;
  }

  // Fixture mode renders even without a valid token, with a fresh 5-minute window.
  const expiresAt = payload ? payload.exp * 1000 : Date.now() + DEMO_TTL_MS;
  const initial: InitialState = preview === "done" ? "done" : "proposed";

  return (
    <ConfirmClient
      actionId={actionId}
      token={t}
      summary={summary}
      expiresAt={expiresAt}
      initial={initial}
      fixtures={fixtures}
      unverified={!payload}
      card={isCardMode(sp)}
    />
  );
}
