// Landing: one line + "Text us to open a shop". Owner: Sahith (SH-A1). Keep tiny: no dashboard, no nav.
import { MessageCircle } from "lucide-react";
import { Button, PageFooter, Wordmark } from "../components";
import styles from "./home.module.css";

const roveNumber = process.env.NEXT_PUBLIC_ROVE_NUMBER?.trim();

// A static, decorative thread: what running a shop by text looks like.
const THREAD: { from: "me" | "rove"; text: string; code?: string }[] = [
  { from: "me", text: "invoice Maya 12.50 for lunch" },
  { from: "rove", text: "Sent. Maya pays with code", code: "K7Q2MX" },
  { from: "rove", text: "Maya paid S$12.50 ✓ Settled on XRPL." },
  { from: "me", text: "withdraw everything" },
];

export default function Home() {
  return (
    <main className={styles.home}>
      <header className={styles.top}>
        <Wordmark size="lg" />
      </header>

      <section className={styles.hero}>
        <h1 className={`twoTone ${styles.headline}`}>
          <span>Your shop, invoices and payouts.</span>
          <span>All in a text thread.</span>
        </h1>

        <ol className={styles.thread} aria-hidden="true">
          {THREAD.map((m, i) => (
            <li key={i} className={m.from === "me" ? styles.me : styles.rove}>
              {m.text}
              {m.code ? <span className={styles.code}>{m.code}</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <div className={styles.cta}>
        {roveNumber ? (
          <Button href={`sms:${roveNumber}`} fullWidth icon={<MessageCircle size={18} strokeWidth={1.75} />}>
            Text us to open a shop
          </Button>
        ) : (
          <p className={styles.soon}>Text us to open a shop. Our number is coming soon.</p>
        )}
        <PageFooter>Apple Pay · card · BNB Chain · settles on XRPL</PageFooter>
      </div>
    </main>
  );
}
