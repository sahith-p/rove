// Merchant: live withdrawal status stepper + step-up confirm for first / large withdrawals
// Owner: Sahith · Task: SH-C2 · Spec: docs/specs/withdrawals.md §3b–3d
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// URL: /w/<id>?t=<session>&a=<actionId>&c=<confirmToken>   (fixture mode also: ?state=<status>&dest=wallet&stepup=0)
import type { Metadata } from "next";
import { headers } from "next/headers";
import { WithdrawalRes } from "@rove/shared";
import { readSession, sessionHeaders } from "../../../lib/ui/session";
import { fixtureDest, isFixtureStatus, withdrawalFixture } from "./_fixtures";
import type { WithdrawalView as View } from "./steps";
import { WithdrawalView } from "./WithdrawalView";
import styles from "./withdrawal.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Withdrawal · Rove" };

type Params = Promise<{ withdrawalId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function Page({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { withdrawalId } = await params;
  const sp = await searchParams;
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
  if (!session && !fixtureMode) return <Expired />;

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

  return (
    <WithdrawalView
      withdrawalId={withdrawalId}
      initial={initial}
      token={t}
      actionId={one(sp.a)}
      confirmToken={one(sp.c)}
      fixture={fixture}
    />
  );
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
      <div className={styles.expiredIcon} aria-hidden="true">
        ⏱
      </div>
      <h2>This link has expired</h2>
      <p className="muted">For your security, withdrawal links don't last forever. Text Rove “withdrawal status” for a fresh one.</p>
    </main>
  );
}
