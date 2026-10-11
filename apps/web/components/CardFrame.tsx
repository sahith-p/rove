// Card mode (`?card=1`, lib/ui/card.ts): the compact layout a page renders LIVE inside an iMessage App card.
// Fills the webview exactly (100dvh, overflow hidden, never scrolls) and sizes fluidly from ~220px to ~500px tall:
//   optional top row (eyebrow · status pill) → one hero (amount or title) → at most one action row. Essentials only.
// The action usually opens the full page in Safari (`CardLink`); /confirm and the /w step-up act in place.
import type { ReactNode } from "react";
import type { Money } from "@rove/shared";
import { ArrowUpRight } from "lucide-react";
import { format } from "../lib/ui/format";
import { Button } from "./Button";
import type { Step } from "./StatusStepper";
import styles from "./CardFrame.module.css";

export interface CardFrameProps {
  /** Top-left: merchant name, "Withdrawal", "Shop setup"… */
  eyebrow?: ReactNode;
  /** Top-right, before the wordmark: usually a StatusPill. */
  status?: ReactNode;
  /** Fixture data. Accepted for call-site clarity; cards show no demo marker (essentials only). */
  demo?: boolean;
  /** The action row (one primary button, or Confirm + Cancel). */
  action?: ReactNode;
  /** Accessible name for the card region. */
  label?: string;
  children: ReactNode;
}

export function CardFrame({ eyebrow, status, action, label, children }: CardFrameProps) {
  return (
    <main className={styles.frame} data-card-frame="" aria-label={label}>
      {eyebrow || status ? (
        <header className={styles.top}>
          <div className={styles.eyebrow}>{eyebrow}</div>
          {status ? <div className={styles.topRight}>{status}</div> : null}
        </header>
      ) : null}
      <div className={styles.body}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </main>
  );
}

/** "S$12.50" sized to the card height, currency prefix muted. */
export function CardAmount({ money, struck }: { money: Money; struck?: boolean }) {
  const text = format(money);
  const m = /^([^\d-]*)(.*)$/.exec(text);
  return (
    <div className={`${styles.amount} ${struck ? styles.struck : ""}`} aria-label={text} role="img">
      {m?.[1] ? (
        <span className={styles.prefix} aria-hidden="true">
          {m[1]}
        </span>
      ) : null}
      <span aria-hidden="true">{m?.[2] ?? text}</span>
    </div>
  );
}

/** A text hero (two-tone when given `sub`). */
export function CardTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <h1 className={styles.title}>
      <span className={styles.titleMain}>{children}</span>
      {sub ? <span className={styles.titleSub}>{sub}</span> : null}
    </h1>
  );
}

/** The one key detail line under the hero. Single line, ellipsized. */
export function CardLine({ children, mono, icon }: { children: ReactNode; mono?: boolean; icon?: ReactNode }) {
  return (
    <p className={`${styles.line} ${mono ? styles.mono : ""}`}>
      {icon ? (
        <span className={styles.lineIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.lineText}>{children}</span>
    </p>
  );
}

/** The mini stepper: one line of dots + the current step's label. */
export function CardDots({ steps }: { steps: Step[] }) {
  const current = steps.find((s) => s.state === "current" || s.state === "failed") ?? [...steps].reverse().find((s) => s.state === "done");
  return (
    <div className={styles.dotsRow}>
      <ol className={styles.dots} aria-label="Progress">
        {steps.map((s, i) => (
          <li key={`${i}-${s.label}`} className={`${styles.dot} ${styles[`dot_${s.state}`]}`}>
            <span className="sr-only">
              {s.label} ({s.state})
            </span>
          </li>
        ))}
      </ol>
      {current ? <span className={styles.dotsLabel}>{current.label}</span> : null}
    </div>
  );
}

/** The card's main button: opens the full page in a new tab / Safari. */
export function CardLink({
  href,
  children,
  icon,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <Button
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      fullWidth
      variant={variant}
      icon={icon}
      trailingIcon={<ArrowUpRight size={16} strokeWidth={1.75} />}
    >
      {children}
    </Button>
  );
}
