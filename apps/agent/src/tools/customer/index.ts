// Customer tools (CustomerToolInputs, docs/specs/invoicing-and-qr.md §7). Merchants get these too.
// Everything is scoped to the sender's phone: lookups are by their own number or by an unguessable code.
// Prices come from the shop's menu in the DB, never from the model.

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import {
  CustomerToolInputs,
  cmp,
  format,
  fromMinor,
  isPositive,
  money,
  toMinor,
  type Invoice,
  type InvoiceLine,
  type Merchant,
  type Recipient,
} from "@rove/shared";
import { defineTool, ToolError } from "../../agent/tool";
import type { ToolContext } from "../context";
import { localDayMonth } from "../../time";
import { matchByName } from "../match";

type Ctx = Omit<ToolContext, "calls">;

const PAY_REQUEST_TTL_MS = 3600 * 1000;


function isExpired(invoice: Invoice, now: Date): boolean {
  return new Date(invoice.expiresAt).getTime() <= now.getTime();
}

function describeLines(lines: InvoiceLine[]): string {
  return lines
    .filter((l) => l.menuItemId !== null)
    .map((l) => `${l.qty}× ${l.name}`)
    .join(", ");
}

async function merchantName(ctx: Ctx, merchantId: string, cache: Map<string, string>): Promise<string> {
  const known = cache.get(merchantId);
  if (known) return known;
  const name = (await ctx.deps.store.getMerchant(merchantId))?.name ?? merchantId;
  cache.set(merchantId, name);
  return name;
}

async function sendPayCard(ctx: Ctx, to: Recipient, invoice: Invoice, merchant?: Merchant | null): Promise<Merchant> {
  const shop = merchant ?? (await ctx.deps.store.getMerchant(invoice.merchantId));
  if (!shop) throw new ToolError("That shop no longer exists.");
  await ctx.deps.outbox.cards.send(to, ctx.deps.builders.invoice({ invoice, merchant: shop }));
  return shop;
}

/** Payment-code fast path (no Claude): send the pay card for a typed code, or a one-line answer. */
export async function payCodeFastPath(ctx: Ctx, from: Recipient, code: string): Promise<string> {
  const invoice = await ctx.deps.store.getInvoiceByCode(code.trim().toUpperCase());
  if (!invoice) return "Hmm, I don't recognise that code. Could you double-check it with the shop?";
  if (invoice.status === "paid") return "Good news, that one's already paid ✓ You're all set.";
  if (invoice.status !== "open" || isExpired(invoice, ctx.deps.now())) return "That code has expired. Ask the shop for a fresh one and I'll sort you out.";
  const shop = await sendPayCard(ctx, from, invoice);
  return `Here you go! ${format(invoice.total)} to ${shop.name}. Tap the card to pay.`;
}

export function customerTools(ctx: ToolContext): BetaRunnableTool[] {
  const { deps, from, calls } = ctx;
  const { store } = deps;

  return [
    defineTool(
      "my_open_invoices",
      "List unpaid invoices that shops sent to this customer's phone number.",
      CustomerToolInputs.my_open_invoices,
      async () => {
        const now = deps.now();
        const open = (await store.openInvoicesForPhone(from.phone)).filter((i) => i.status === "open" && !isExpired(i, now));
        if (!open.length) return "No open invoices for this number.";
        const names = new Map<string, string>();
        const rows = [];
        for (const inv of open) rows.push(`${inv.code} · ${await merchantName(ctx, inv.merchantId, names)} · ${format(inv.total)}`);
        return rows.join("\n");
      },
      calls,
    ),

    defineTool(
      "pay_invoice",
      "Re-send the pay card for an invoice that was sent to this customer (use the code from my_open_invoices).",
      CustomerToolInputs.pay_invoice,
      async ({ code }) => {
        const invoice = await store.getInvoiceByCode(code.trim().toUpperCase());
        if (!invoice || invoice.to?.phone !== from.phone) return "No invoice with that code was sent to this number.";
        if (invoice.status === "paid") return "That invoice is already paid ✓";
        if (invoice.status !== "open" || isExpired(invoice, deps.now())) return "That invoice has expired or was cancelled.";
        const shop = await sendPayCard(ctx, from, invoice);
        return `Pay card sent: ${format(invoice.total)} to ${shop.name} (code ${invoice.code}).`;
      },
      calls,
    ),

    defineTool(
      "pay_code",
      "The customer texted a 6-character payment code: send its pay card.",
      CustomerToolInputs.pay_code,
      async ({ code }) => payCodeFastPath(ctx, from, code),
      calls,
    ),

    defineTool(
      "pay_shop",
      "Pay a shop by text, e.g. 'pay ahseng 6.50' or 'pay Ah Seng 2 chicken rice'. Find the shop by shop code, phone or name; prices come from its menu.",
      CustomerToolInputs.pay_shop,
      async ({ shop, amount, items }) => {
        const shops = await store.findShop(shop);
        if (!shops.length) return `I couldn't find a shop called ${shop}.`;
        if (shops.length > 1) {
          return `Several shops match "${shop}": ${shops.map((s) => `${s.name} (shop code ${s.id})`).join(", ")}. Ask which one.`;
        }
        const merchant = shops[0]!;
        if (ctx.merchant && ctx.merchant.id === merchant.id) throw new ToolError("You can't pay your own shop.");
        if (merchant.status !== "live") return `${merchant.name} isn't taking payments yet.`;

        const menu = await store.listMenu(merchant.id);
        if (!amount && !items?.length) {
          await deps.outbox.cards.send(from, deps.builders.menu({ merchant, menu }));
          return `Sent ${merchant.name}'s menu.`;
        }

        const currency = merchant.currency;
        let lines: InvoiceLine[];
        if (items?.length) {
          lines = [];
          for (const ref of items) {
            const m = matchByName(ref.name, menu, (i) => i.name);
            if (m.kind === "none") {
              const closest = m.closest.map((i) => i.name).join(", ");
              return `${merchant.name} has no "${ref.name}" on the menu.${closest ? ` Closest: ${closest}.` : ""} Ask the customer.`;
            }
            if (m.kind === "many") return `"${ref.name}" could be ${m.items.map((i) => i.name).join(" or ")}. Ask which.`;
            lines.push({ menuItemId: m.item.id, name: m.item.name, qty: ref.qty, unit: m.item.price });
          }
        } else {
          lines = [{ menuItemId: null, name: "Payment", qty: 1, unit: money(amount!, currency) }];
        }

        const total = fromMinor(
          lines.reduce((sum, l) => sum + toMinor(l.unit) * BigInt(l.qty), 0n),
          currency,
        );
        if (!isPositive(total)) throw new ToolError("The amount must be more than zero.");
        if (cmp(total, money(deps.config.maxInvoiceSgd, currency)) > 0) {
          throw new ToolError(`That's over the ${format(money(deps.config.maxInvoiceSgd, currency))} limit for one payment.`);
        }

        const invoice = await store.createInvoice({
          merchantId: merchant.id,
          kind: "pay_request",
          contactId: null,
          to: from,
          lines,
          total,
          note: null,
          expiresAt: new Date(deps.now().getTime() + PAY_REQUEST_TTL_MS).toISOString(),
        });
        await sendPayCard(ctx, from, invoice, merchant);
        const detail = describeLines(lines);
        return `Pay request ${format(total)} to ${merchant.name}${detail ? ` (${detail})` : ""} · card sent · code ${invoice.code}`;
      },
      calls,
    ),

    defineTool(
      "my_receipts",
      "List this customer's recent payments (receipts).",
      CustomerToolInputs.my_receipts,
      async ({ limit }) => {
        const receipts = await store.receiptsForPhone(from.phone, limit);
        if (!receipts.length) return "No payments from this number yet.";
        return receipts
          .map((p) => `${format(p.local)} · ${p.merchantName} · ${localDayMonth(new Date(p.createdAt))} · ${p.status.replace(/_/g, " ")}`)
          .join("\n");
      },
      calls,
    ),

    defineTool(
      "start_shop",
      "The person wants to open their own shop on Rove: begin merchant onboarding.",
      CustomerToolInputs.start_shop,
      async () => {
        if (ctx.merchant) return "You already have a shop.";
        await ctx.onboarding.start(from);
        return "Onboarding started; the next messages walk them through it. Reply with one short line.";
      },
      calls,
    ),
  ];
}
