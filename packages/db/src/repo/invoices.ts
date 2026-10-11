// invoices, one-time QR codes and customer pay requests

import { fromMinor, newId, newShortCode, toMinor, type InvoiceKind } from "@rove/shared";
import type { Param, Pool } from "../executor";
import type { Db } from "../index";
import { INVOICE_COLS, linesToDb, norm, normalizePhone, toInvoice } from "../map";

type InvoicesRepo = Pick<
  Db,
  | "createInvoice"
  | "getInvoice"
  | "getInvoiceByCode"
  | "listInvoices"
  | "openInvoicesForPhone"
  | "markInvoicePaid"
  | "cancelInvoice"
  | "expireInvoices"
  | "invoicesToRemind"
  | "setInvoiceReminded"
>;

/** Default lifetime by kind (invoicing-and-qr.md §1). */
export const INVOICE_TTL_SECONDS: Record<InvoiceKind, number> = {
  invoice: 7 * 24 * 3600,
  one_time_qr: 30 * 60,
  pay_request: 60 * 60,
};

/** A payment for this invoice got past `created`: don't expire or cancel it under the customer's feet. */
const HAS_LIVE_PAYMENT = `exists (select 1 from payments p where p.invoice_id = invoices.id
  and p.status in ('authorized','settling','settled','partially_refunded','refunded'))`;

const CODE_ATTEMPTS = 10;

export function invoicesRepo(pool: Pool): InvoicesRepo {
  const many = async (sql: string, params: Param[]) => (await pool.query(sql, params)).map(toInvoice);
  const one = async (sql: string, params: Param[]) => (await many(sql, params))[0] ?? null;

  return {
    async createInvoice(i) {
      const total = norm(i.total);
      if (toMinor(total) <= 0n) throw new Error("@rove/db: invoice total must be positive");
      const lines = linesToDb(i.lines); // validates qty
      let sum = 0n;
      for (const l of i.lines) {
        if (l.unit.currency !== total.currency) throw new Error(`@rove/db: line "${l.name}" is in ${l.unit.currency}, invoice in ${total.currency}`);
        sum += BigInt(l.qty) * toMinor(norm(l.unit));
      }
      if (sum !== toMinor(total)) {
        throw new Error(`@rove/db: invoice total ${total.amount} doesn't match its lines (${fromMinor(sum, total.currency).amount})`);
      }
      const to = i.to ? { phone: normalizePhone(i.to.phone), channel: i.to.channel } : null;

      // Codes are random 6-char strings; on the rare collision, draw again.
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        const rows = await pool.query(
          `insert into invoices (id, code, merchant_id, kind, contact_id, to_phone, to_channel, lines, total, currency, note, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::numeric, $10, $11,
                   coalesce($12::timestamptz, now() + make_interval(secs => $13)))
           on conflict (code) do nothing
           returning ${INVOICE_COLS}`,
          [
            newId("inv"),
            newShortCode(),
            i.merchantId,
            i.kind,
            i.contactId ?? null,
            to?.phone ?? null,
            to?.channel ?? null,
            lines,
            total.amount,
            total.currency,
            i.note ?? null,
            i.expiresAt ?? null,
            INVOICE_TTL_SECONDS[i.kind],
          ],
        );
        if (rows[0]) return toInvoice(rows[0]);
      }
      throw new Error("@rove/db: couldn't allocate a unique invoice code");
    },

    getInvoice: (id) => one(`select ${INVOICE_COLS} from invoices where id = $1`, [id]),

    getInvoiceByCode: (code) => one(`select ${INVOICE_COLS} from invoices where code = upper(trim($1))`, [code]),

    listInvoices(merchantId, status) {
      const filter =
        status === "open" ? "and status = 'open' and expires_at > now()" : status === "paid" ? "and status = 'paid'" : "";
      return many(`select ${INVOICE_COLS} from invoices where merchant_id = $1 ${filter} order by created_at desc, id`, [merchantId]);
    },

    openInvoicesForPhone: (phone) =>
      many(
        `select ${INVOICE_COLS} from invoices where to_phone = $1 and status = 'open' and expires_at > now() order by created_at desc, id`,
        [normalizePhone(phone)],
      ),

    async markInvoicePaid(id, paymentId) {
      // From any unpaid status: a payment that got through wins over a sweep that expired the code meanwhile.
      const rows = await pool.query(`update invoices set status = 'paid', payment_id = $2 where id = $1 and status <> 'paid' returning id`, [
        id,
        paymentId,
      ]);
      return rows.length > 0;
    },

    async cancelInvoice(merchantId, code) {
      const rows = await pool.query(
        `update invoices set status = 'cancelled'
          where merchant_id = $1 and code = upper(trim($2)) and status = 'open' and not ${HAS_LIVE_PAYMENT}
          returning id`,
        [merchantId, code],
      );
      return rows.length > 0;
    },

    expireInvoices: (now) =>
      many(
        `update invoices set status = 'expired'
          where status = 'open' and expires_at <= coalesce($1::timestamptz, now()) and not ${HAS_LIVE_PAYMENT}
          returning ${INVOICE_COLS}`,
        [now ? now.toISOString() : null],
      ),

    invoicesToRemind: (olderThan) =>
      many(
        `select ${INVOICE_COLS} from invoices
          where status = 'open' and kind = 'invoice' and reminded_at is null and created_at < $1::timestamptz and expires_at > now()
          order by created_at`,
        [olderThan.toISOString()],
      ),

    async setInvoiceReminded(id) {
      await pool.query(`update invoices set reminded_at = now() where id = $1`, [id]);
    },
  };
}
