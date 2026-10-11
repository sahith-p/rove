// The hero number on a page: "S$12.50", with the currency prefix muted (two-tone) and an optional line under it.
// Left-aligned by default (Ramp); `align="center"` for centered compositions.
import type { Money } from "@rove/shared";
import { format } from "../lib/ui/format";
import styles from "./Amount.module.css";

export interface AmountProps {
  money: Money;
  sub?: string;
  /** Small uppercase label above the number ("AMOUNT DUE"). */
  label?: string;
  align?: "start" | "center";
  size?: "lg" | "md";
  className?: string;
}

/** "S$12.50" → ["S$", "12.50"]. */
function split(text: string): [string, string] {
  const m = /^([^\d-]*)(.*)$/.exec(text);
  return [m?.[1] ?? "", m?.[2] ?? text];
}

export function Amount({ money, sub, label, align = "start", size = "lg", className }: AmountProps) {
  const text = format(money);
  const [prefix, value] = split(text);
  return (
    <div className={[styles.amount, align === "center" && styles.center, size === "md" && styles.md, className].filter(Boolean).join(" ")}>
      {label ? <span className="eyebrow">{label}</span> : null}
      <div className={styles.value} aria-label={text}>
        {prefix ? (
          <span className={styles.prefix} aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        <span aria-hidden="true">{value}</span>
      </div>
      {sub ? <div className={styles.sub}>{sub}</div> : null}
    </div>
  );
}
