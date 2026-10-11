// Line-item math for display (invoice lines, the fixed-QR cart). bigint minor units only, never floats.
// The amount actually charged always comes from the API/DB; use these to show a breakdown.
import { add, fromMinor, toMinor, zero, type Currency, type InvoiceLine, type Money } from "@rove/shared";

/** unit × qty, e.g. 2 × S$4.50 → S$9.00. */
export function lineTotal(line: InvoiceLine): Money {
  return fromMinor(toMinor(line.unit) * BigInt(line.qty), line.unit.currency);
}

/** Sum of line totals. `currency` is needed for an empty list. */
export function linesTotal(lines: InvoiceLine[], currency: Currency): Money {
  return lines.reduce<Money>((sum, line) => add(sum, lineTotal(line)), zero(currency));
}
