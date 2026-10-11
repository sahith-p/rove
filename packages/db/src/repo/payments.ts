// payments: checkout rows, CAS transitions, settlement, reporting

import { fromMinor, newId, toMinor, type DaySummary, type PaymentStatus } from "@rove/shared";
import type { Param, Pool } from "../executor";
import type { Db } from "../index";
import { decimal, dbMoney, linesToDb, norm, normalizePhone, PAYMENT_COLS, toPayment } from "../map";
import { appendLedgerIn } from "./ledger";
import { inJson, lockMerchant, merchantCurrency, SetBuilder, sgtDayRange } from "./util";

type PaymentsRepo = Pick<
  Db,
  | "insertPayment"
  | "getPayment"
  | "getPaymentByStripePI"
  | "getPaymentByDepositAddress"
  | "transitionPayment"
  | "listPaymentsByStatus"
  | "listPayments"
  | "receiptsForPhone"
  | "daySummary"
  | "completeSettlement"
  | "nextDepositIndex"
>;

/** Payments that count as money received (receipts). */
const RECEIPT_STATUSES: PaymentStatus[] = ["authorized", "settling", "settled", "partially_refunded", "refunded"];

export function paymentsRepo(pool: Pool): PaymentsRepo {
  const many = async (sql: string, params: Param[]) => (await pool.query(sql, params)).map(toPayment);
  const one = async (sql: string, params: Param[]) => (await many(sql, params))[0] ?? null;

  return {
    async insertPayment(p) {
      const local = norm(p.local);
      const charge = norm(p.charge);
      const q = p.quote;
      const rows = await pool.query(
        `insert into payments (id, merchant_id, source, invoice_id, lines, amount_local, currency,
            quote_usd, quote_rate, quote_send_max_usd, quote_expires_at, charge_amount, charge_currency,
            method, payer_phone, payer_channel, stripe_payment_intent, bnb_deposit_address)
         values ($1, $2, $3, $4, $5::text::jsonb, $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric, $11::timestamptz,
                 $12::numeric, $13, $14, $15, $16, $17, $18)
         returning ${PAYMENT_COLS}`,
        [
          p.id,
          p.merchantId,
          p.source,
          p.invoiceId,
          linesToDb(p.lines),
          local.amount,
          local.currency,
          q ? norm(q.usd).amount : null,
          q ? decimal(q.rate) : null,
          q ? decimal(q.sendMaxUsd) : null,
          q ? q.expiresAt : null,
          charge.amount,
          charge.currency,
          p.method,
          p.payer ? normalizePhone(p.payer.phone) : null,
          p.payer?.channel ?? null,
          p.stripePaymentIntentId ?? null,
          p.bnbDepositAddress ?? null,
        ],
      );
      return toPayment(rows[0]!);
    },

    getPayment: (id) => one(`select ${PAYMENT_COLS} from payments where id = $1`, [id]),
    getPaymentByStripePI: (pi) => one(`select ${PAYMENT_COLS} from payments where stripe_payment_intent = $1`, [pi]),
    getPaymentByDepositAddress: (address) =>
      one(`select ${PAYMENT_COLS} from payments where lower(bnb_deposit_address) = lower($1)`, [address]),

    transitionPayment(id, from, to, patch = {}) {
      const params: Param[] = [id, JSON.stringify(from)];
      const set = new SetBuilder(params).add("status", to).raw("updated_at = now()");
      if (patch.method !== undefined) set.add("method", patch.method);
      if (patch.stripePaymentIntentId !== undefined) set.add("stripe_payment_intent", patch.stripePaymentIntentId);
      if (patch.payinTxHash !== undefined) set.add("payin_tx_hash", patch.payinTxHash);
      if (patch.settleTxHash !== undefined) set.add("settle_tx_hash", patch.settleTxHash);
      if (patch.deliveredAmount !== undefined) set.add("delivered_amount", decimal(patch.deliveredAmount), "::numeric");
      if (patch.failureReason !== undefined) set.add("failure_reason", patch.failureReason);
      if (patch.quote !== undefined) {
        const q = patch.quote;
        set
          .add("quote_usd", q ? norm(q.usd).amount : null, "::numeric")
          .add("quote_rate", q ? decimal(q.rate) : null, "::numeric")
          .add("quote_send_max_usd", q ? decimal(q.sendMaxUsd) : null, "::numeric")
          .add("quote_expires_at", q ? q.expiresAt : null, "::timestamptz");
      }
      // A second authorization for the same invoice hits payments_one_per_invoice → DbConflictError (executor).
      return one(`update payments set ${set.sql} where id = $1 and status in ${inJson(2)} returning ${PAYMENT_COLS}`, params);
    },

    listPaymentsByStatus: (statuses, limit = 100) =>
      many(`select ${PAYMENT_COLS} from payments where status in ${inJson(1)} order by updated_at, id limit $2`, [
        JSON.stringify(statuses),
        limit,
      ]),

    listPayments: (merchantId, limit = 20) =>
      many(`select ${PAYMENT_COLS} from payments where merchant_id = $1 order by created_at desc, id limit $2`, [merchantId, limit]),

    receiptsForPhone: (phone, limit = 10) =>
      many(
        `select ${PAYMENT_COLS} from payments where payer_phone = $1 and status in ${inJson(2)} order by created_at desc, id limit $3`,
        [normalizePhone(phone), JSON.stringify(RECEIPT_STATUSES), limit],
      ),

    async daySummary(merchantId, date): Promise<DaySummary> {
      // From the ledger, so "how much today?" agrees with the balance: sales credited and refunds made that SGT day.
      const { start, end } = sgtDayRange(date);
      const currency = await merchantCurrency(pool, merchantId);
      const [sums] = await pool.query<{ count: number; gross: string; refunded: string }>(
        `select count(*) filter (where kind = 'payment_credit')::int as count,
                coalesce(sum(amount) filter (where kind = 'payment_credit'), 0)::text as gross,
                coalesce(sum(amount) filter (where kind = 'refund_debit'), 0)::text as refunded
           from ledger_entries
          where merchant_id = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
        [merchantId, start, end],
      );
      const [open] = await pool.query<{ n: number }>(
        `select count(*)::int as n from invoices where merchant_id = $1 and status = 'open' and expires_at > now()`,
        [merchantId],
      );
      const gross = dbMoney(sums!.gross, currency);
      const refunded = dbMoney(sums!.refunded, currency);
      return {
        merchantId,
        date,
        count: Number(sums!.count),
        gross,
        refunded,
        net: fromMinor(toMinor(gross) - toMinor(refunded), currency),
        openInvoices: Number(open!.n),
      };
    },

    completeSettlement(paymentId, r) {
      const delivered = decimal(r.delivered);
      return pool.tx(async (q) => {
        const head = await q.query<{ merchant_id: string }>(`select merchant_id from payments where id = $1`, [paymentId]);
        if (!head[0]) return null;
        const merchantId = head[0].merchant_id;
        await lockMerchant(q, merchantId); // serializes firstSale per merchant

        const rows = await q.query(
          `update payments set status = 'settled', settle_tx_hash = $2, delivered_amount = $3::numeric, updated_at = now()
            where id = $1 and status = 'settling' returning ${PAYMENT_COLS}`,
          [paymentId, r.txHash, delivered],
        );
        if (!rows[0]) return null;
        const payment = toPayment(rows[0]);

        const credited = await appendLedgerIn(q, { merchantId, kind: "payment_credit", amount: payment.local, ref: payment.id });
        let firstSale = false;
        if (credited) {
          const [c] = await q.query<{ n: number }>(
            `select count(*)::int as n from ledger_entries where merchant_id = $1 and kind = 'payment_credit'`,
            [merchantId],
          );
          firstSale = Number(c!.n) === 1;
        }

        if (payment.invoiceId) {
          await q.query(`update invoices set status = 'paid', payment_id = $2 where id = $1 and status <> 'paid'`, [payment.invoiceId, payment.id]);
        }
        if (payment.payer) {
          // Auto-add the payer; an existing contact keeps its name (the merchant can rename with "add Maya +65…").
          await q.query(
            `insert into contacts (id, merchant_id, name, phone, channel) values ($1, $2, $3, $3, $4)
             on conflict (merchant_id, phone) do update set channel = coalesce(contacts.channel, excluded.channel)`,
            [newId("ct"), merchantId, payment.payer.phone, payment.payer.channel],
          );
        }
        return { payment, firstSale };
      });
    },

    async nextDepositIndex() {
      const [row] = await pool.query<{ n: number }>(`select nextval('bsc_deposit_index')::int as n`);
      return Number(row!.n);
    },
  };
}
