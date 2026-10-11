"use client";
// Small USD/SGD switch: the payer is charged in their own currency so the card leg never converts
// (docs/specs/payments-stripe.md §1a). The default comes from the browser locale; never from IP.
import type { Currency } from "@rove/shared";
import styles from "./pay.module.css";

const OPTIONS: Currency[] = ["SGD", "USD"];

/** en-SG / Asia/Singapore → SGD, everyone else → USD (other payer currencies fall back to USD for now). */
export function localeCurrency(): Currency {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    if (tz === "Asia/Singapore" || langs.some((l) => /-SG\b/i.test(l))) return "SGD";
  } catch {
    // fall through
  }
  return "USD";
}

export interface CurrencyToggleProps {
  value: Currency;
  onChange: (c: Currency) => void;
  disabled?: boolean;
  busy?: boolean;
}

export function CurrencyToggle({ value, onChange, disabled, busy }: CurrencyToggleProps) {
  return (
    <div className={styles.currencyRow}>
      <span className={styles.currencyLabel}>Pay in</span>
      <div className={styles.segmented} role="radiogroup" aria-label="Pay in currency" aria-busy={busy || undefined}>
        {OPTIONS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            className={value === c ? styles.segOn : styles.seg}
            disabled={disabled}
            onClick={() => value !== c && onChange(c)}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
