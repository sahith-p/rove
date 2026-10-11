"use client";
// Pay-in switch over every enabled currency (registry: packages/shared/src/currencies.ts; today SGD · USD · EUR).
// The payer is charged in their own currency so the card leg never converts (docs/specs/payments-stripe.md §1a).
// The default comes from the browser locale; never from IP.
import { CURRENCY_CODES, payerCurrencyFor, type Currency } from "@rove/shared";
import { CurrencyFlag } from "../../../components/icons";
import styles from "./pay.module.css";

/** The merchant's currency first, then the rest in registry order. */
function optionsFor(local?: Currency): Currency[] {
  const all = [...CURRENCY_CODES];
  return local && all.includes(local) ? [local, ...all.filter((c) => c !== local)] : all;
}

/** Locale region (en-SG → SG, de-DE → DE) or the time zone → the registry's currency for that country; else USD. */
export function localeCurrency(): Currency {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === "Asia/Singapore") return payerCurrencyFor({ country: "SG" });
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const l of langs) {
      const region = /[-_]([A-Za-z]{2})\b/.exec(l)?.[1];
      if (region) return payerCurrencyFor({ country: region });
    }
    if (tz.startsWith("Europe/")) return payerCurrencyFor({ country: "DE" });
  } catch {
    // fall through
  }
  return payerCurrencyFor({});
}

export interface CurrencyToggleProps {
  value: Currency;
  onChange: (c: Currency) => void;
  disabled?: boolean;
  busy?: boolean;
  /** The merchant's currency, listed first. */
  local?: Currency;
}

export function CurrencyToggle({ value, onChange, disabled, busy, local }: CurrencyToggleProps) {
  return (
    <div className={styles.currencyRow}>
      <span className="eyebrow" id="pay-in-label">
        Pay in
      </span>
      <div className={styles.segmented} role="radiogroup" aria-labelledby="pay-in-label" aria-busy={busy || undefined}>
        {optionsFor(local).map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            className={value === c ? styles.segOn : styles.seg}
            disabled={disabled}
            onClick={() => value !== c && onChange(c)}
          >
            <CurrencyFlag currency={c} size={16} />
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
