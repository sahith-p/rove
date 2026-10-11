// Label-left / value-right detail rows in one hairline frame, divided by hairlines (Ramp).
// <Rows label="Details"><Row label="Paid with" value="Apple Pay" /><Row label="Payment ID" value="pay_…" mono /></Rows>
import type { ReactNode } from "react";
import styles from "./Rows.module.css";

export interface RowsProps {
  /** Small uppercase label above the frame. */
  label?: string;
  className?: string;
  children: ReactNode;
}

export function Rows({ label, className, children }: RowsProps) {
  const list = <dl className={styles.rows}>{children}</dl>;
  if (!label) return <div className={className}>{list}</div>;
  return (
    <section className={[styles.group, className].filter(Boolean).join(" ")}>
      <span className="eyebrow">{label}</span>
      {list}
    </section>
  );
}

export interface RowProps {
  label: ReactNode;
  value: ReactNode;
  /** Geist Mono value: ids, hashes, codes, references. */
  mono?: boolean;
  /** Small leading icon in the value cell. */
  icon?: ReactNode;
  /** Value color for meaning. */
  tone?: "success" | "error" | "muted";
}

export function Row({ label, value, mono, icon, tone }: RowProps) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd className={[mono && styles.mono, tone && styles[tone]].filter(Boolean).join(" ") || undefined}>
        {icon ? (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className={styles.value}>{value}</span>
      </dd>
    </div>
  );
}
