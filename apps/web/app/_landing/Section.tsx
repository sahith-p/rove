// Landing section wrapper: mono eyebrow, serif title, muted lede, then content.
import type { ReactNode } from "react";
import styles from "./landing.module.css";

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  className,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={[styles.section, className].filter(Boolean).join(" ")}>
      <div className={styles.sectionHead}>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id={headingId} className={styles.sectionTitle}>
          {title}
        </h2>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
      </div>
      {children}
    </section>
  );
}
