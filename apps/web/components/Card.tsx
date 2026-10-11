// Hairline frame: same color as the page, grouped by a 1px border. Never a gray fill.
// With `label`, renders a small uppercase label row above the frame ("ORDER", "DETAILS").
import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Small uppercase label above the frame. */
  label?: string;
  /** Right side of the label row (a count, a hint). */
  aside?: string;
  /** No inner padding: for lists whose rows bring their own. */
  flush?: boolean;
}

export function Card({ className, label, aside, flush, children, ...rest }: CardProps) {
  const frameClass = [styles.card, flush && styles.flush].filter(Boolean).join(" ");
  if (!label) {
    return (
      <div {...rest} className={[frameClass, className].filter(Boolean).join(" ")}>
        {children}
      </div>
    );
  }
  return (
    <section {...rest} className={[styles.group, className].filter(Boolean).join(" ")}>
      <div className={styles.head}>
        <span className="eyebrow">{label}</span>
        {aside ? <span className={`eyebrow ${styles.aside}`}>{aside}</span> : null}
      </div>
      <div className={frameClass}>{children}</div>
    </section>
  );
}
