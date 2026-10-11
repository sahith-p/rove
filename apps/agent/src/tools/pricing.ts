// Shared by merchant + customer tools: turn "2 chicken rice and a barley" (or a free amount) into priced
// invoice lines from the DB, and deliver an invoice's pay card. Prices never come from the model.
//
//   resolveLines(deps, merchant, items?, amount?) → { lines, total } | { problem }
//   deliverInvoice(deps, invoice, merchant)      → SentMessage (pay card to invoice.to)
//   describeLines(lines)                          → "2× Chicken rice, 1× Barley drink"
//   parseAmount(amount, currency)                 → Money | null (null = not a valid amount)
//   sgtDate(d) / sgtTime(d)                       → "2026-10-11" / "3:42pm" in Asia/Singapore

import { cmp, format, fromMinor, isPositive, money, toMinor, type Invoice, type InvoiceLine, type Merchant, type Money, type SentMessage } from "@rove/shared";
import type { Deps } from "../ports";
import { matchByName } from "./match";

export interface ItemRef {
  name: string;
  qty: number;
}

export type Priced = { lines: InvoiceLine[]; total: Money } | { problem: string };

/** Decimal string → Money in the shop currency; null if malformed or more than 2 decimals. */
export function parseAmount(amount: string, currency: Money["currency"]): Money | null {
  try {
    return money(amount, currency);
  } catch {
    return null;
  }
}

/** Menu items (matched by name, priced from the DB) or a single free-amount line. Enforces 0 < total ≤ cap. */
export async function resolveLines(deps: Deps, merchant: Merchant, items?: ItemRef[], amount?: string): Promise<Priced> {
  const currency = merchant.currency;
  const lines: InvoiceLine[] = [];
  if (items && items.length > 0) {
    const menu = await deps.store.listMenu(merchant.id);
    if (menu.length === 0) return { problem: `${merchant.name} has no menu items yet.` };
    for (const ref of items) {
      const m = matchByName(ref.name, menu, (i) => i.name);
      if (m.kind === "none") {
        const closest = m.closest.map((i) => i.name).join(", ");
        return { problem: `No menu item like "${ref.name}".${closest ? ` Closest: ${closest}.` : ""}` };
      }
      if (m.kind === "many") return { problem: `Which one did you mean for "${ref.name}": ${m.items.map((i) => i.name).join(" or ")}?` };
      const existing = lines.find((l) => l.menuItemId === m.item.id);
      if (existing) existing.qty += ref.qty;
      else lines.push({ menuItemId: m.item.id, name: m.item.name, qty: ref.qty, unit: m.item.price });
    }
  } else if (amount !== undefined) {
    const unit = parseAmount(amount, currency);
    if (!unit) return { problem: `"${amount}" isn't a valid amount.` };
    lines.push({ menuItemId: null, name: "Payment", qty: 1, unit });
  } else {
    return { problem: "Need menu items or an amount." };
  }

  const total = fromMinor(
    lines.reduce((sum, l) => sum + toMinor(l.unit) * BigInt(l.qty), 0n),
    currency,
  );
  if (!isPositive(total)) return { problem: "The amount must be more than zero." };
  const cap = money(deps.config.maxInvoiceSgd, currency);
  if (cmp(total, cap) > 0) return { problem: `${format(total)} is over the ${format(cap)} limit for one payment.` };
  return { lines, total };
}

export function describeLines(lines: InvoiceLine[]): string {
  return lines.map((l) => (l.menuItemId ? `${l.qty}× ${l.name}` : format(l.unit))).join(", ");
}

/** Send the invoice's pay card to its recipient (iMessage app card). */
export async function deliverInvoice(deps: Deps, invoice: Invoice, merchant: Merchant): Promise<SentMessage> {
  if (!invoice.to) throw new Error(`invoice ${invoice.code} has no recipient`);
  return deps.outbox.cards.send(invoice.to, deps.builders.invoice({ invoice, merchant }));
}

const SGT = "Asia/Singapore";

export function sgtDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SGT, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function sgtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: SGT, hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .replace(" ", "")
    .toLowerCase();
}
