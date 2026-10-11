// Small SQL helpers shared by the repo modules.

import type { Currency } from "@rove/shared";
import type { Executor, Param } from "../executor";

/** `col in <IN_JSON(n)>` with params[n-1] = JSON.stringify(list): an IN list without driver-specific array params. */
export const inJson = (n: number) => `(select jsonb_array_elements_text($${n}::text::jsonb))`;

/** Collects `col = $n` assignments for dynamic UPDATEs. */
export class SetBuilder {
  readonly sets: string[] = [];
  constructor(readonly params: Param[]) {}
  add(col: string, value: Param, cast = ""): this {
    this.params.push(value);
    this.sets.push(`${col} = $${this.params.length}${cast}`);
    return this;
  }
  raw(fragment: string): this {
    this.sets.push(fragment);
    return this;
  }
  get sql(): string {
    return this.sets.join(", ");
  }
}

/** Row lock on the merchant: serializes balance-changing transactions for one merchant. False if it doesn't exist. */
export async function lockMerchant(q: Executor, merchantId: string): Promise<boolean> {
  return (await q.query(`select id from merchants where id = $1 for update`, [merchantId])).length > 0;
}

export async function merchantCurrency(q: Executor, merchantId: string): Promise<Currency> {
  const rows = await q.query<{ currency: Currency }>(`select currency from merchants where id = $1`, [merchantId]);
  return rows[0]?.currency ?? "SGD";
}

const DAY_MS = 24 * 3600 * 1000;
const SGT_OFFSET_MS = 8 * 3600 * 1000; // Asia/Singapore is UTC+8 all year (no DST since 1982)

/** [start, end) of a calendar day in Asia/Singapore, as ISO instants. */
export function sgtDayRange(date: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`@rove/db: date must be YYYY-MM-DD, got ${date}`);
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) throw new Error(`@rove/db: invalid date ${date}`);
  return { start: start.toISOString(), end: new Date(start.getTime() + DAY_MS).toISOString() };
}

/** Today's date in Asia/Singapore, YYYY-MM-DD. */
export function sgtToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Escapes LIKE wildcards in user text. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
