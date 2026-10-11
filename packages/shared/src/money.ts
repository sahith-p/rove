// Money is always a decimal string + currency. Never use JS floats for amounts.
// All arithmetic goes through bigint minor units.

export type Currency = "SGD" | "USD";

export interface Money {
  /** Decimal string, e.g. "6.50". Up to `DECIMALS[currency]` places. */
  amount: string;
  currency: Currency;
}

export const DECIMALS: Record<Currency, number> = { SGD: 2, USD: 2 };

const SYMBOL: Record<Currency, string> = { SGD: "S$", USD: "US$" };

const DECIMAL_RE = /^\d+(\.\d+)?$/;

export type Rounding = "exact" | "floor" | "ceil";

/** Parse a decimal string into integer units at `decimals` places. */
export function toUnits(value: string, decimals: number, rounding: Rounding = "exact"): bigint {
  if (!DECIMAL_RE.test(value)) throw new Error(`invalid decimal: ${value}`);
  const [whole = "0", frac = ""] = value.split(".");
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const dropped = frac.slice(decimals);
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept || "0");
  const hasRemainder = /[1-9]/.test(dropped);
  if (!hasRemainder) return base;
  if (rounding === "exact") throw new Error(`too many decimal places for ${decimals}: ${value}`);
  return rounding === "ceil" ? base + 1n : base;
}

/** Format integer units back into a decimal string with exactly `decimals` places. */
export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${neg ? "-" : ""}${whole}${decimals ? "." + frac : ""}`;
}

export function money(amount: string, currency: Currency): Money {
  return { amount: fromUnits(toUnits(amount, DECIMALS[currency], "exact"), DECIMALS[currency]), currency };
}

export function toMinor(m: Money): bigint {
  return toUnits(m.amount, DECIMALS[m.currency], "exact");
}

export function fromMinor(minor: bigint, currency: Currency): Money {
  return { amount: fromUnits(minor, DECIMALS[currency]), currency };
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return fromMinor(toMinor(a) + toMinor(b), a.currency);
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return fromMinor(toMinor(a) - toMinor(b), a.currency);
}

/** -1 | 0 | 1 */
export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  const d = toMinor(a) - toMinor(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function isPositive(m: Money): boolean {
  return toMinor(m) > 0n;
}

export function zero(currency: Currency): Money {
  return fromMinor(0n, currency);
}

/** "S$6.50" */
export function format(m: Money): string {
  return `${SYMBOL[m.currency]}${m.amount}`;
}
