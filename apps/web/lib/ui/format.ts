// Display helpers for pages. Owner: Sahith (SH-A1). Money stays a decimal string; this only formats it.
import { format as formatShared, type Money } from "@rove/shared";

/** "S$6.50". Same as `format` from @rove/shared. */
export function format(m: Money): string {
  return formatShared(m);
}

/** "A1B2…F9E0" (keeps a leading "0x": "0x1a2b…9f0e"). Short hashes are returned as is. */
export function shortHash(hash: string, keep = 4): string {
  const prefix = hash.startsWith("0x") ? "0x" : "";
  const body = hash.slice(prefix.length);
  if (body.length <= keep * 2 + 1) return hash;
  return `${prefix}${body.slice(0, keep)}…${body.slice(-keep)}`;
}

/** "••••1234". Only ever shows the last 4 characters, even if handed more. */
export function maskAccount(last4: string): string {
  return `••••${last4.slice(-4)}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dateFmt = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", timeZone: "Asia/Singapore" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "just now" · "5 minutes ago" · "in 12 minutes" · "yesterday" · "3 days ago" · "12 Oct" (beyond a week). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "just now";
  if (abs >= 7 * 86_400) return dateFmt.format(t);
  for (const [unit, sec] of UNITS) {
    if (abs >= sec) return rtf.format(Math.trunc(diffSec / sec), unit);
  }
  return rtf.format(diffSec < 0 ? -1 : 1, "minute");
}
