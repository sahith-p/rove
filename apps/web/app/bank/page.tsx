// Merchant: secure bank details form (PayNow UEN / mobile / bank account). Opened from the bank card.
// Owner: Sahith · Task: SH-C1 · Spec: docs/specs/withdrawals.md §2
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// The full account number only ever lives in the client form state until it's POSTed; never in the URL or logs.
import type { Metadata } from "next";
import { readSession } from "../../lib/ui/session";
import { BankForm } from "./BankForm";
import { LockIcon } from "./icons";
import styles from "./bank.module.css";

export const metadata: Metadata = {
  title: "Add your bank · Rove",
  robots: { index: false, follow: false },
  // The session token is in the URL; don't leak it to anything this page links to.
  referrer: "no-referrer",
};

const DEMO = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t } = await searchParams;
  const token = (Array.isArray(t) ? t[0] : t) ?? "";

  let session: ReturnType<typeof readSession> = null;
  try {
    session = readSession(token, ["bank"]);
  } catch (err) {
    // Only a missing TOKEN_SECRET throws. Fixture mode runs without one; otherwise it's a real misconfiguration.
    if (!DEMO) throw err;
  }

  if (!session && !DEMO) return <Expired />;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.lockBadge} aria-hidden="true">
          <LockIcon size={22} />
        </span>
        <h1>Add your bank</h1>
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
          <LockIcon size={22} />
        </span>
        <h1>Link expired</h1>
        <p className="muted">This link expired (links last 15 minutes). Text Rove &lsquo;add my bank&rsquo; for a new one.</p>
      </div>
    </main>
  );
}
