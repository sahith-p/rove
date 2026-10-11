// "2 × Chicken rice   S$9.00" rows + a total row. Line totals use bigint money math (lib/ui/lines.ts), never floats.
// Pass `total` from the API (the DB total is what gets charged); without it the lines are summed.
import type { InvoiceLine, Money } from "@rove/shared";
import { format } from "../lib/ui/format";
import { lineTotal, linesTotal } from "../lib/ui/lines";
import styles from "./LineItems.module.css";

export interface LineItemsProps {
  lines: InvoiceLine[];
  total?: Money;
  totalLabel?: string;
}

export function LineItems({ lines, total, totalLabel = "Total" }: LineItemsProps) {
  const currency = total?.currency ?? lines[0]?.unit.currency;
  if (!currency) return null;
  const shownTotal = total ?? linesTotal(lines, currency);

  return (
    <div className={styles.wrap}>
      {lines.length > 0 ? (
        <ul className={styles.list}>
          {lines.map((line, i) => (
            <li key={`${line.menuItemId ?? "free"}-${i}`} className={styles.row}>
              <div className={styles.name}>
                <span className={styles.qty}>{line.qty} ×</span> {line.name}
                {line.qty > 1 ? <div className={styles.each}>{format(line.unit)} each</div> : null}
              </div>
              <div className={styles.price}>{format(lineTotal(line))}</div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.total}>
        <span>{totalLabel}</span>
        <span className={styles.price}>{format(shownTotal)}</span>
      </div>
    </div>
  );
}
