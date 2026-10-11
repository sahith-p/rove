// bank accounts (beneficiary id + last 4 only) and withdrawals (withdrawals.md §3)

import { cmp, newId } from "@rove/shared";
import type { Param, Pool } from "../executor";
import type { ApproveWithdrawalResult, Db } from "../index";
import { BANK_COLS, dbMoney, norm, toBankAccount, toWithdrawal, WITHDRAWAL_COLS } from "../map";
import { appendLedgerIn, balanceIn } from "./ledger";
import { inJson, lockMerchant, merchantCurrency, SetBuilder, sgtDayRange, sgtToday } from "./util";

type WithdrawalsRepo = Pick<
  Db,
  | "insertBankAccount"
  | "listBankAccounts"
  | "getBankAccount"
  | "getDefaultBankAccount"
  | "insertWithdrawal"
  | "getWithdrawal"
  | "transitionWithdrawal"
  | "approveWithdrawal"
  | "listWithdrawals"
  | "listWithdrawalsByStatus"
  | "withdrawnToday"
  | "hasCompletedWithdrawal"
>;

export function withdrawalsRepo(pool: Pool): WithdrawalsRepo {
  const bank = async (sql: string, params: Param[]) => (await pool.query(sql, params)).map(toBankAccount);
  const many = async (sql: string, params: Param[]) => (await pool.query(sql, params)).map(toWithdrawal);
  const one = async (sql: string, params: Param[]) => (await many(sql, params))[0] ?? null;

  return {
    insertBankAccount(b) {
      return pool.tx(async (q) => {
        if (!(await lockMerchant(q, b.merchantId))) throw new Error(`@rove/db: unknown merchant ${b.merchantId}`);
        const rows = await q.query(
          `insert into bank_accounts (id, merchant_id, type, bank_name, last4, holder_name, beneficiary_id, status, is_default)
           values ($1, $2, $3, $4, $5, $6, $7, $8, not exists (select 1 from bank_accounts where merchant_id = $2))
           returning ${BANK_COLS}`,
          [newId("bank"), b.merchantId, b.type, b.bankName, b.last4, b.holderName, b.beneficiaryId, b.status],
        );
        return toBankAccount(rows[0]!);
      });
    },

    listBankAccounts: (merchantId) =>
      bank(`select ${BANK_COLS} from bank_accounts where merchant_id = $1 order by is_default desc, created_at desc, id`, [merchantId]),

    getBankAccount: async (id) => (await bank(`select ${BANK_COLS} from bank_accounts where id = $1`, [id]))[0] ?? null,

    getDefaultBankAccount: async (merchantId) =>
      (await bank(`select ${BANK_COLS} from bank_accounts where merchant_id = $1 and is_default order by created_at desc limit 1`, [merchantId]))[0] ??
      null,

    async insertWithdrawal(w) {
      const amount = norm(w.amount);
      const fee = norm(w.fee);
      const rows = await pool.query(
        `insert into withdrawals (id, merchant_id, amount_local, fee_local, currency, destination_kind, bank_account_id, wallet_address, needs_step_up)
         values ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8, $9)
         returning ${WITHDRAWAL_COLS}`,
        [
          newId("wd"),
          w.merchantId,
          amount.amount,
          fee.amount,
          amount.currency,
          w.destination.kind,
          w.destination.kind === "bank" ? w.destination.bankAccountId : null,
          w.destination.kind === "xrpl_wallet" ? w.destination.address : null,
          w.needsStepUp,
        ],
      );
      return toWithdrawal(rows[0]!);
    },

    getWithdrawal: (id) => one(`select ${WITHDRAWAL_COLS} from withdrawals where id = $1`, [id]),

    transitionWithdrawal(id, from, to, patch = {}) {
      const params: Param[] = [id, JSON.stringify(from)];
      const set = new SetBuilder(params).add("status", to).raw("updated_at = now()");
      if (patch.sweepTxHash !== undefined) set.add("sweep_tx_hash", patch.sweepTxHash);
      if (patch.partnerPayoutId !== undefined) set.add("partner_payout_id", patch.partnerPayoutId);
      if (patch.bankRef !== undefined) set.add("bank_ref", patch.bankRef);
      if (patch.failureReason !== undefined) set.add("failure_reason", patch.failureReason);
      return one(`update withdrawals set ${set.sql} where id = $1 and status in ${inJson(2)} returning ${WITHDRAWAL_COLS}`, params);
    },

    approveWithdrawal(id, actionId): Promise<ApproveWithdrawalResult> {
      return pool.tx(async (q): Promise<ApproveWithdrawalResult> => {
        const head = await q.query<{ merchant_id: string }>(`select merchant_id from withdrawals where id = $1`, [id]);
        if (!head[0]) return { ok: false, reason: "not_requested", withdrawal: null };
        // Merchant row lock first: concurrent approvals (and settlements) for this merchant queue up here, so the
        // balance read below can't be stale.
        await lockMerchant(q, head[0].merchant_id);
        const [row] = await q.query(`select ${WITHDRAWAL_COLS} from withdrawals where id = $1 for update`, [id]);
        const w = toWithdrawal(row!);
        if (w.status !== "requested") return { ok: false, reason: "not_requested", withdrawal: w };

        // The hold is the amount that leaves the account (the fee, S$0 for FAST, is taken out of it, not on top).
        const { available } = await balanceIn(q, w.merchantId);
        if (cmp(available, w.amount) < 0) return { ok: false, reason: "insufficient_funds", withdrawal: w };

        const [updated] = await q.query(
          `update withdrawals set status = 'approved', action_id = $2, updated_at = now()
            where id = $1 and status = 'requested' returning ${WITHDRAWAL_COLS}`,
          [id, actionId],
        );
        await appendLedgerIn(q, { merchantId: w.merchantId, kind: "withdrawal_hold", amount: w.amount, ref: w.id });
        return { ok: true, withdrawal: toWithdrawal(updated!) };
      });
    },

    listWithdrawals: (merchantId, limit = 20) =>
      many(`select ${WITHDRAWAL_COLS} from withdrawals where merchant_id = $1 order by created_at desc, id limit $2`, [merchantId, limit]),

    listWithdrawalsByStatus: (statuses) =>
      many(`select ${WITHDRAWAL_COLS} from withdrawals where status in ${inJson(1)} order by created_at, id`, [JSON.stringify(statuses)]),

    async withdrawnToday(merchantId) {
      const { start, end } = sgtDayRange(sgtToday());
      const currency = await merchantCurrency(pool, merchantId);
      const [row] = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_local), 0)::text as total from withdrawals
          where merchant_id = $1 and status not in ('failed', 'cancelled')
            and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
        [merchantId, start, end],
      );
      return dbMoney(row!.total, currency);
    },

    async hasCompletedWithdrawal(merchantId) {
      const rows = await pool.query(`select 1 from withdrawals where merchant_id = $1 and status = 'completed' limit 1`, [merchantId]);
      return rows.length > 0;
    },
  };
}
