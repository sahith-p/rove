// The largest thing on a pay/receipt page: "S$12.50", with an optional small line under it ("≈ US$9.69").
import type { Money } from "@rove/shared";
import { format } from "../lib/ui/format";
import styles from "./Amount.module.css";

export interface AmountProps {
  money: Money;
  sub?: string;
  className?: string;
}

export function Amount({ money, sub, className }: AmountProps) {
  return (
    <div className={[styles.amount, className].filter(Boolean).join(" ")}>
      <div className={styles.value}>{format(money)}</div>
      {sub ? <div className={styles.sub}>{sub}</div> : null}
    </div>
  );
}
