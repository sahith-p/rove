// Shop name (+ "✓ Verified on XRPL" badge) at the top of customer pages. `name` is merchant-written text: render only.
import styles from "./MerchantHeader.module.css";

export interface MerchantHeaderProps {
  name: string;
  verified?: boolean;
  /** Optional link for the badge, e.g. the merchant's account on the XRPL explorer. */
  verifiedHref?: string;
  className?: string;
}

export function MerchantHeader({ name, verified, verifiedHref, className }: MerchantHeaderProps) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <header className={[styles.header, className].filter(Boolean).join(" ")}>
      <span className={styles.avatar} aria-hidden="true">
        {initial}
      </span>
      <div className={styles.text}>
        <div className={styles.name}>{name}</div>
        {verified ? (
          verifiedHref ? (
            <a className={styles.badge} href={verifiedHref} target="_blank" rel="noopener noreferrer">
              ✓ Verified on XRPL
            </a>
          ) : (
            <span className={styles.badge}>✓ Verified on XRPL</span>
          )
        ) : null}
      </div>
    </header>
  );
}
