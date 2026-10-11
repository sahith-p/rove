// append-only ledger + the balance view (withdrawals.md §1)
//   available = Σ payment_credit + Σ withdrawal_release + Σ withdrawal_return − Σ refund_debit − Σ withdrawal_hold
//   held      = Σ withdrawal_hold − Σ withdrawal_release − Σ withdrawal_debit

import { add, newId, type Balance, type Currency, type LedgerKind, type Money } from "@rove/shared";
import type { Executor, Pool } from "../executor";
import type { Db } from "../index";
import { dbMoney, norm } from "../map";

type LedgerRepo = Pick<Db, "appendLedger" | "getBalance">;

/** Balance from the merchant_balances view, inside whatever transaction `q` is. */
export async function balanceIn(q: Executor, merchantId: string): Promise<Balance> {
  const rows = await q.query<{ currency: Currency; available: string; held: string }>(
    `select m.currency, coalesce(b.available, 0)::text as available, coalesce(b.held, 0)::text as held
       from merchants m left join merchant_balances b on b.merchant_id = m.id
      where m.id = $1`,
    [merchantId],
  );
  const r = rows[0] ?? { currency: "SGD" as Currency, available: "0", held: "0" };
  const available = dbMoney(r.available, r.currency);
  const held = dbMoney(r.held, r.currency);
  return { available, held, total: add(available, held) };
}

/** Idempotent append: false when (kind, ref) already exists. */
export async function appendLedgerIn(
  q: Executor,
  e: { merchantId: string; kind: LedgerKind; amount: Money; ref: string },
): Promise<boolean> {
  const amount = norm(e.amount);
  const rows = await q.query(
    `insert into ledger_entries (id, merchant_id, kind, amount, currency, ref) values ($1, $2, $3, $4::numeric, $5, $6)
     on conflict (kind, ref) do nothing returning id`,
    [newId("led"), e.merchantId, e.kind, amount.amount, amount.currency, e.ref],
  );
  return rows.length > 0;
}

export function ledgerRepo(pool: Pool): LedgerRepo {
  return {
    appendLedger: (e) => appendLedgerIn(pool, e),
    getBalance: (merchantId) => balanceIn(pool, merchantId),
  };
}
