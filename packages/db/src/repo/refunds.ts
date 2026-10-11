// refunds (one per confirmed action) and the payment's refunded total

import { newId } from "@rove/shared";
import type { Param, Pool } from "../executor";
import type { Db } from "../index";
import { norm, PAYMENT_COLS, REFUND_COLS, toPayment, toRefund } from "../map";
import { SetBuilder } from "./util";

type RefundsRepo = Pick<Db, "insertRefund" | "getRefundByAction" | "updateRefund" | "addPaymentRefund">;

export function refundsRepo(pool: Pool): RefundsRepo {
  const one = async (sql: string, params: Param[]) => {
    const rows = await pool.query(sql, params);
    return rows[0] ? toRefund(rows[0]) : null;
  };

  return {
    async insertRefund(r) {
      // Idempotent on action_id: a retried executor gets the refund it already created back.
      const amount = norm(r.amount);
      const created = await one(
        `insert into refunds (id, payment_id, merchant_id, action_id, amount_local, currency) values ($1, $2, $3, $4, $5::numeric, $6)
         on conflict (action_id) do nothing returning ${REFUND_COLS}`,
        [newId("ref"), r.paymentId, r.merchantId, r.actionId, amount.amount, amount.currency],
      );
      return created ?? (await one(`select ${REFUND_COLS} from refunds where action_id = $1`, [r.actionId]))!;
    },

    getRefundByAction: (actionId) => one(`select ${REFUND_COLS} from refunds where action_id = $1`, [actionId]),

    updateRefund(id, patch) {
      const params: Param[] = [id];
      const set = new SetBuilder(params);
      if (patch.status !== undefined) set.add("status", patch.status);
      if (patch.stripeRefundId !== undefined) set.add("stripe_refund_id", patch.stripeRefundId);
      if (patch.xrplTxHash !== undefined) set.add("xrpl_tx_hash", patch.xrplTxHash);
      if (patch.failureReason !== undefined) set.add("failure_reason", patch.failureReason);
      if (!set.sets.length) return one(`select ${REFUND_COLS} from refunds where id = $1`, params);
      return one(`update refunds set ${set.sql} where id = $1 returning ${REFUND_COLS}`, params);
    },

    async addPaymentRefund(paymentId, amount) {
      // One statement = one transaction. Null if the payment isn't refundable or this would refund more than was paid.
      const a = norm(amount);
      const rows = await pool.query(
        `update payments set
           refunded_local = refunded_local + $2::numeric,
           status = case when refunded_local + $2::numeric >= amount_local then 'refunded' else 'partially_refunded' end,
           updated_at = now()
         where id = $1 and currency = $3 and status in ('settled', 'partially_refunded')
           and $2::numeric > 0 and refunded_local + $2::numeric <= amount_local
         returning ${PAYMENT_COLS}`,
        [paymentId, a.amount, a.currency],
      );
      return rows[0] ? toPayment(rows[0]) : null;
    },
  };
}
