// Merchant: live withdrawal status stepper + step-up confirm for first / large withdrawals
// Owner: Sahith · Task: SH-C2 · Spec: docs/specs/withdrawals.md §3b–3d
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// URL: /w/<id>?t=<session>&a=<actionId>&c=<confirmToken>   (fixture mode also: ?state=<status>&dest=wallet&stepup=0)
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Clock } from "lucide-react";
import { WithdrawalRes } from "@rove/shared";
import { CardFrame, CardTitle, IconBadge } from "../../../components";
import { fullPageHref, isCardMode } from "../../../lib/ui/card";
import { readSession, sessionHeaders } from "../../../lib/ui/session";
import { previewMetadata } from "../../../lib/og/metadata";
import { fixtureDest, isFixtureStatus, withdrawalFixture } from "./_fixtures";
import { withdrawalCopy } from "./_preview";
import type { WithdrawalView as View } from "./steps";
import { WithdrawalView } from "./WithdrawalView";
import styles from "./withdrawal.module.css";

export const dynamic = "force-dynamic";

type SearchRecord = Record<string, string | string[] | undefined>;
type Params = Promise<{ withdrawalId: string }>;
type Search = Promise<SearchRecord>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/** State-aware preview text (SH-B3): "Withdrawal S$118.40 · In your bank ✓". Image: opengraph-image.tsx. */
export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const [{ withdrawalId }, sp] = await Promise.all([params, searchParams]);
  const { initial } = await resolve(withdrawalId, sp);
  const robots = { index: false, follow: false };
  // The session token is in the URL; don't leak it to anything this page links to.
  const referrer = "no-referrer" as const;
  if (!initial) {
    return previewMetadata({ title: "Withdrawal · Rove", description: "Live status of your Rove withdrawal.", robots, referrer });
  }
  const { title, description } = withdrawalCopy(initial);
  return previewMetadata({ title, description, robots, referrer });
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { withdrawalId } = await params;
  const sp = await searchParams;
  const { expired, t, initial, fixture } = await resolve(withdrawalId, sp);
  const card = isCardMode(sp);
  if (expired) {
    return card ? (
      <CardFrame eyebrow="Withdrawal">
        <CardTitle sub="Text Rove “withdrawal status” for a fresh one.">This link has expired</CardTitle>
      </CardFrame>
    ) : (
      <Expired />
    );
  }

  return (
    <WithdrawalView
      withdrawalId={withdrawalId}
      initial={initial}
      token={t}
      actionId={one(sp.a)}
      confirmToken={one(sp.c)}
      fixture={fixture}
      cardHref={card ? fullPageHref(`/w/${encodeURIComponent(withdrawalId)}`, sp) : null}
    />
  );
}

/** Session check + first-paint data, shared by the page and its metadata. */
async function resolve(withdrawalId: string, sp: SearchRecord) {
  const t = one(sp.t);
  const fixtureMode = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

  let session: ReturnType<typeof readSession> = null;
  try {
    session = readSession(t ?? undefined, ["withdrawal", "shop"]);
  } catch {
    session = null; // TOKEN_SECRET missing: treat as no session
  }
  // A withdrawal-scoped link only opens its own withdrawal.
  if (session?.scope === "withdrawal" && session.ref && session.ref !== withdrawalId) session = null;
  if (!session && !fixtureMode) return { expired: true, t, initial: null, fixture: false };

  let initial: View | null = session && t ? await fetchWithdrawal(withdrawalId, t) : null;
  let fixture = false;
  if (!initial && fixtureMode) {
    const state = one(sp.state) ?? undefined;
    initial = withdrawalFixture(
      withdrawalId,
      isFixtureStatus(state) ? state : "requested",
      fixtureDest(withdrawalId, one(sp.dest) ?? undefined),
      one(sp.stepup) !== "0",
    );
    fixture = true;
  }
  return { expired: false, t, initial, fixture };
}

/** First paint from the API so the card opens on the right step. null on 501 / any failure (the client keeps polling). */
async function fetchWithdrawal(id: string, t: string): Promise<View | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    const res = await fetch(`${proto}://${host}/api/withdrawals/${encodeURIComponent(id)}`, {
      headers: sessionHeaders(t),
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const parsed = WithdrawalRes.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function Expired() {
  return (
    <main className={styles.expired}>
      <IconBadge>
        <Clock size={22} strokeWidth={1.5} />
      </IconBadge>
      <h1 className={styles.expiredTitle}>This link has expired</h1>
      <p className="muted">For your security, withdrawal links don't last forever. Text Rove “withdrawal status” for a fresh one.</p>
    </main>
  );
}
