// Small presentational pieces shared by every page: the wordmark, status pills, state icon badges, the page footer.
import type { ReactNode } from "react";
import styles from "./Bits.module.css";

/** "Rove" in the display serif, near-black: the same mark as app/icon.png. */
export function Wordmark({ size = "md", className }: { size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  return <span className={[styles.wordmark, styles[`wm_${size}`], className].filter(Boolean).join(" ")}>Rove</span>;
}

export type PillTone = "success" | "pending" | "error" | "neutral" | "progress";

/** Hairline pill with a meaning-colored dot: [● Paid] [● Settling…]. Pending / progress dots pulse. */
export function StatusPill({
  tone,
  children,
  icon,
  className,
  role,
  live,
}: {
  tone: PillTone;
  children: ReactNode;
  /** Replaces the dot (e.g. a 12px check). */
  icon?: ReactNode;
  className?: string;
  role?: "status";
  live?: boolean;
}) {
  return (
    <span
      className={[styles.pill, styles[`pill_${tone}`], className].filter(Boolean).join(" ")}
      role={role}
      aria-live={live ? "polite" : undefined}
    >
      {icon ? (
        <span className={styles.pillIcon} aria-hidden="true">
          {icon}
        </span>
      ) : (
        <span className={styles.dot} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

/** Round icon badge heading a state ("Paid", "Expired", "Failed"). success = solid green; others = hairline ring. */
export function IconBadge({
  tone = "neutral",
  size = "md",
  children,
  className,
}: {
  tone?: "neutral" | "success" | "error";
  size?: "md" | "lg";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={[styles.badge, styles[`badge_${tone}`], size === "lg" && styles.badgeLg, className].filter(Boolean).join(" ")} aria-hidden="true">
      {children}
    </span>
  );
}

/** Quiet page footer: "rove · Settles on XRPL" (+ a DEMO tag in fixture mode). */
export function PageFooter({ children, demo, className }: { children?: ReactNode; demo?: boolean; className?: string }) {
  return (
    <footer className={[styles.footer, className].filter(Boolean).join(" ")}>
      <Wordmark size="sm" />
      {children ? (
        <>
          <span className={styles.sep} aria-hidden="true" />
          <span>{children}</span>
        </>
      ) : null}
      {demo ? <span className={styles.demo}>Demo</span> : null}
    </footer>
  );
}

/** Square hairline tile holding a list-row icon (shop rows, bank header). */
export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={[styles.tile, className].filter(Boolean).join(" ")} aria-hidden="true">
      {children}
    </span>
  );
}
