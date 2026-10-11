// What a checkout pays for: an invoice code or a fixed-QR basket, resolved against the DB. Owner: Nithya · Task: NI-B2
// Spec: docs/specs/payments-stripe.md §1, §1a · docs/specs/invoicing-and-qr.md §1
//
// Amounts never come from the client: invoice totals are the invoice's, fixed-QR baskets are priced from the menu.

import type { z } from "zod";
import type { Db } from "@rove/db";
import {
  cmp,
  fixedQrMaxFor,
  format,
  fromMinor,
  money,
  payerCurrencyFor,
  toMinor,
  type CheckoutReq,
  type Currency,
  type InvoiceLine,
  type Money,
  type PaymentSource,
  type Recipient,
} from "@rove/shared";
import { HttpError } from "../_lib/http";

export type CheckoutBody = z.infer<typeof CheckoutReq>;

/** Fixed-QR payments are capped per merchant currency (invoicing-and-qr.md §1, registry `limits.fixedQrMax`):
 *  S$500, €350, US$400. This is the SGD cap, kept for existing callers. */
export const FIXED_QR_MAX: Money = fixedQrMaxFor("SGD");

export interface CheckoutTarget {
  merchantId: string;
  source: PaymentSource;
  invoiceId: string | null;
  lines: InvoiceLine[];
  local: Money;
  payer: Recipient | null;
}

/**
 * A phone typed on the pay page has no channel. The DB keeps a payer only with a channel (Recipient), so default to
 * iMessage (the demo channel); an invoice's own recipient keeps its real channel.
 */
function payerFromPhone(phone: string | undefined, known: Recipient | null): Recipient | null {
  if (!phone) return known;
  if (known && known.phone === phone) return known;
  return { phone, channel: "imessage" };
}

export async function resolveTarget(db: Db, body: CheckoutBody, now = Date.now()): Promise<CheckoutTarget> {
  const t = body.target;
  if (t.source === "invoice") {
    const invoice = await db.getInvoiceByCode(t.code.trim());
    if (!invoice) throw new HttpError(404, "invoice_not_found", "This payment code doesn't exist. Check it, or ask the shop for a new one.");
    if (invoice.status === "paid") throw new HttpError(409, "invoice_paid", "This has already been paid.");
    if (invoice.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "The shop cancelled this request.");
    if (invoice.status === "expired" || Date.parse(invoice.expiresAt) <= now) {
      throw new HttpError(409, "invoice_expired", "This code has expired. Ask the shop for a new one.");
    }
    return {
      merchantId: invoice.merchantId,
      source: invoice.kind, // invoice | one_time_qr | pay_request: the same names as PaymentSource
      invoiceId: invoice.id,
      lines: invoice.lines,
      local: invoice.total,
      payer: invoice.to ?? payerFromPhone(body.payerPhone, null),
    };
  }

  const merchant = await db.getMerchant(t.merchantId);
  if (!merchant) throw new HttpError(404, "merchant_not_found", "This shop doesn't exist.");
  if (merchant.status !== "live") throw new HttpError(409, "merchant_not_live", "This shop isn't taking payments yet.");

  let lines: InvoiceLine[] = [];
  let local: Money;
  if (t.items && t.items.length > 0) {
    // Prices from the DB only. Same item twice → one line with the quantities added.
    const menu = new Map((await db.listMenu(merchant.id)).map((m) => [m.id, m]));
    const byId = new Map<string, InvoiceLine>();
    for (const { menuItemId, qty } of t.items) {
      const item = menu.get(menuItemId);
      if (!item || !item.active) throw new HttpError(400, "menu_item_unavailable", "Something in this order isn't on the menu any more.");
      if (item.price.currency !== merchant.currency) throw new Error(`menu item ${item.id} is priced in ${item.price.currency}, shop in ${merchant.currency}`);
      const line = byId.get(menuItemId);
      if (line) line.qty += qty;
      else byId.set(menuItemId, { menuItemId, name: item.name, qty, unit: item.price });
    }
    lines = [...byId.values()];
    local = fromMinor(
      lines.reduce((sum, l) => sum + BigInt(l.qty) * toMinor(l.unit), 0n),
      merchant.currency,
    );
  } else if (t.amount !== undefined) {
    try {
      local = money(t.amount, merchant.currency);
    } catch {
      throw new HttpError(400, "invalid_amount", "Enter an amount with at most 2 decimal places.");
    }
  } else {
    throw new HttpError(400, "amount_required", "Pick something from the menu or enter an amount.");
  }

  if (toMinor(local) <= 0n) throw new HttpError(400, "invalid_amount", "The amount must be more than zero.");
  const max = fixedQrMaxFor(merchant.currency);
  if (cmp(local, max) > 0) throw new HttpError(400, "amount_over_limit", `Payments by shop QR are limited to ${format(max)}.`);

  return { merchantId: merchant.id, source: "fixed_qr", invoiceId: null, lines, local, payer: payerFromPhone(body.payerPhone, null) };
}

/**
 * The currency the payer is charged in (§1a, corridors.md §2): what the page asked for (any enabled currency), else the
 * payer's phone country if Rove settles in that currency (+65 → SGD, +49 → EUR, +1 → USD; +91 → USD while INR is
 * planned), else USD. The stablecoin lanes are always USD (USDT and AUSD are dollars).
 */
export function payerCurrency(body: Pick<CheckoutBody, "method" | "payCurrency">, payer: Recipient | null): Currency {
  if (body.method !== "card") return "USD";
  return payerCurrencyFor({ requested: body.payCurrency, phone: payer?.phone });
}
