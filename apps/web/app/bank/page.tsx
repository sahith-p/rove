// Merchant: secure bank details form (PayNow UEN / mobile / bank account). Opened from the bank card.
// Owner: Sahith · Task: SH-C1 · Spec: docs/specs/withdrawals.md §2
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// The full account number only ever lives in the client form state until it's POSTed; never in the URL or logs.
import type { Metadata } from "next";
import { previewMetadata } from "../../lib/og/metadata";
import { CardFrame, CardLink, CardTitle } from "../../components";
import { fullPageHref, isCardMode } from "../../lib/ui/card";
import { readSession } from "../../lib/ui/session";
import { BankForm } from "./BankForm";
import { LockIcon } from "./icons";
import styles from "./bank.module.css";

export function generateMetadata(): Promise<Metadata> {
  return previewMetadata({
    title: "Add your bank · Rove",
    description: "Securely add the bank account Rove pays out to. Rove only keeps the last 4 digits.",
    robots: { index: false, follow: false },
    // The session token is in the URL; don't leak it to anything this page links to.
    referrer: "no-referrer",
  });
}

const DEMO = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { t } = sp;
  const token = (Array.isArray(t) ? t[0] : t) ?? "";
  const card = isCardMode(sp);

  let session: ReturnType<typeof readSession> = null;
  try {
    session = readSession(token, ["bank"]);
  } catch (err) {
    // Only a missing TOKEN_SECRET throws. Fixture mode runs without one; otherwise it's a real misconfiguration.
    if (!DEMO) throw err;
  }

  if (!session && !DEMO) return card ? <ExpiredCard /> : <Expired />;

  if (card) {
    return (
      <CardFrame
        demo={DEMO && !session}
        action={
          <CardLink href={fullPageHref("/bank", sp)} icon={<LockIcon size={17} />}>
            Open secure form
          </CardLink>
        }
      >
        <CardTitle>Add your bank</CardTitle>
      </CardFrame>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.lockBadge} aria-hidden="true">
          <LockIcon size={20} />
        </span>
        <h1 className="twoTone">
          <span>Add your bank</span>
          <span>Where your payouts land.</span>
        </h1>
        <p className={styles.reassure}>
          Your details go straight to our licensed payout partner. Rove only keeps the last 4 digits.
        </p>
      </header>
      <BankForm token={token} demo={DEMO} unverifiedSession={!session} />
    </main>
  );
}

function Expired() {
  return (
    <main className={styles.page}>
      <div className={styles.expired}>
        <span className={styles.lockBadge} aria-hidden="true">
          <LockIcon size={20} />
        </span>
        <h1 className={styles.expiredTitle}>Link expired</h1>
        <p className="muted">This link expired (links last 15 minutes). Text Rove &lsquo;add my bank&rsquo; for a new one.</p>
      </div>
    </main>
  );
}

function ExpiredCard() {
  return (
    <CardFrame>
      <CardTitle sub="Text Rove ‘add my bank’ for a new one.">Link expired</CardTitle>
    </CardFrame>
  );
}
