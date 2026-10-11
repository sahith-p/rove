// Shown for a missing / tampered / expired / mismatched confirm token, and when the countdown runs out.
import styles from "./confirm.module.css";

export function ExpiredView() {
  return (
    <main className={styles.page}>
      <div className={styles.result}>
        <span className={`${styles.badge} ${styles.badgeMuted}`} aria-hidden="true">
          <ClockIcon />
        </span>
        <h1 className={styles.headline}>
          This request expired.
          <span className={styles.headlineSub}>Ask Rove again.</span>
        </h1>
        <p className="muted">Requests last 5 minutes. Nothing happened, and nothing will until you confirm a new one.</p>
      </div>
    </main>
  );
}

export function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
