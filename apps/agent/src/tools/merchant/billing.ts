// Merchant tools for getting paid: invoices, one-time codes/QRs, the fixed QR sticker.

import { format, MerchantToolInputs, type Contact, type Invoice } from "@rove/shared";
import { defineTool, ToolError } from "../../agent/tool";
import type { ToolContext } from "../context";
import { matchByName } from "../match";
import { deliverInvoice, describeLines, resolveLines, sgtTime } from "../pricing";
import { personLabel, requireMerchant } from "./util";

const DAY_MS = 24 * 3600 * 1000;

export function billingTools(ctx: ToolContext) {
  const { deps, from, calls } = ctx;
  const merchant = requireMerchant(ctx);
  const { store, outbox, builders, links, qr } = deps;

  const invoiceLine = (i: Invoice, contacts: Contact[]) =>
    `${i.code} ${format(i.total)} ${i.kind === "one_time_qr" ? "one-time QR" : `to ${personLabel(i.to?.phone, contacts)}`} · ${i.status}` +
    ` · ${describeLines(i.lines)}`;

  return [
    defineTool(
      "create_invoice",
      "Text a customer a payment request. `to` is a saved contact's name or a phone number; items are priced from the menu (or use amount for a free amount). If the contact is unknown, ask for their number — don't guess.",
      MerchantToolInputs.create_invoice,
      async ({ to, items, amount, note }) => {
        const contacts = await store.findContacts(merchant.id);
        let contact: Contact | undefined;
        if (to.phone) {
          contact = contacts.find((c) => c.phone === to.phone);
          if (!contact) {
            const name = to.contactName?.trim() || to.phone;
            contact = await store.addContact(merchant.id, { name, phone: to.phone, channel: null });
          }
        } else if (to.contactName) {
          const m = matchByName(to.contactName, contacts, (c) => c.name);
          if (m.kind === "none") throw new ToolError(`No contact named "${to.contactName}". Ask for their phone number. No invoice was created.`);
          if (m.kind === "many") throw new ToolError(`Which ${to.contactName}: ${m.items.map((c) => `${c.name} ${c.phone}`).join(" or ")}? No invoice was created.`);
          contact = m.item;
        } else {
          throw new ToolError("Who is this invoice for? Need a contact name or phone number.");
        }

        const priced = await resolveLines(deps, merchant, items, amount);
        if ("problem" in priced) throw new ToolError(`${priced.problem} No invoice was created.`);

        const channel = contact.channel ?? (await outbox.resolveChannel(contact.phone));
        const invoice = await store.createInvoice({
          merchantId: merchant.id,
          kind: "invoice",
          contactId: contact.id,
          to: { phone: contact.phone, channel },
          lines: priced.lines,
          total: priced.total,
          note: note ?? null,
          expiresAt: new Date(deps.now().getTime() + 7 * DAY_MS).toISOString(),
        });
        await deliverInvoice(deps, invoice, merchant);
        return `Sent to ${contact.name} ✓ ${format(invoice.total)} (${describeLines(invoice.lines)}) · code ${invoice.code}`;
      },
      calls,
    ),
    defineTool(
      "create_one_time_qr",
      "Make a single-use payment code + QR for a fixed amount or menu items (expires in 30 minutes). The merchant shows the QR; customers scan it or text the code to Rove.",
      MerchantToolInputs.create_one_time_qr,
      async ({ items, amount, note }) => {
        const priced = await resolveLines(deps, merchant, items, amount);
        if ("problem" in priced) throw new ToolError(`${priced.problem} No code was created.`);
        const expiresAt = new Date(deps.now().getTime() + 30 * 60 * 1000);
        const invoice = await store.createInvoice({
          merchantId: merchant.id,
          kind: "one_time_qr",
          contactId: null,
          to: null,
          lines: priced.lines,
          total: priced.total,
          note: note ?? null,
          expiresAt: expiresAt.toISOString(),
        });
        const url = links.pay(invoice.code);
        const caption = `${format(invoice.total)} · single use · expires ${sgtTime(expiresAt)}`;
        const png = await qr.qrPng(url);
        if (png) await outbox.image(from, png, `rove-${invoice.code}.png`, `${caption} · code ${invoice.code}`);
        else await outbox.text(from, `${caption}\nCode ${invoice.code} · ${url}`);
        return `One-time code ${invoice.code} for ${format(invoice.total)} (${describeLines(invoice.lines)}), expires ${sgtTime(expiresAt)}. ${png ? "QR image" : "Link"} sent. Customers scan it or text ${invoice.code} to Rove.`;
      },
      calls,
    ),
    defineTool(
      "get_fixed_qr",
      "Send the shop's permanent QR sticker and menu card.",
      MerchantToolInputs.get_fixed_qr,
      async () => {
        const url = links.shop(merchant.id);
        const png = await qr.stickerPng({ name: merchant.name, url, verified: merchant.credentialStatus === "accepted", shopCode: merchant.id });
        if (png) await outbox.image(from, png, `rove-${merchant.id}-sticker.png`, `${merchant.name} · shop code ${merchant.id}`);
        else await outbox.text(from, `${merchant.name} · ${url}\nShop code: ${merchant.id}`);
        const menu = await store.listMenu(merchant.id);
        if (menu.length) await outbox.cards.send(from, builders.menu({ merchant, menu }));
        return `Fixed QR ${png ? "sticker" : "link"} sent (${url}). Shop code ${merchant.id}: customers scan it or text "pay ${merchant.id} 6.50" to Rove.`;
      },
      calls,
    ),
    defineTool(
      "list_invoices",
      "List the shop's invoices and one-time codes (open by default).",
      MerchantToolInputs.list_invoices,
      async ({ status }) => {
        const [invoices, contacts] = await Promise.all([store.listInvoices(merchant.id, status), store.findContacts(merchant.id)]);
        if (!invoices.length) return status === "all" ? "No invoices yet." : `No ${status} invoices.`;
        return invoices.slice(0, 15).map((i) => invoiceLine(i, contacts)).join("\n");
      },
      calls,
    ),
    defineTool(
      "remind_invoice",
      "Re-send an open invoice to its customer with a friendly nudge.",
      MerchantToolInputs.remind_invoice,
      async ({ code }) => {
        const invoice = await store.getInvoiceByCode(code.trim().toUpperCase());
        if (!invoice || invoice.merchantId !== merchant.id) throw new ToolError(`No invoice ${code}.`);
        if (invoice.kind !== "invoice" || !invoice.to) throw new ToolError(`${invoice.code} isn't addressed to anyone, so there's no one to remind.`);
        if (invoice.status !== "open") throw new ToolError(`${invoice.code} is ${invoice.status}.`);
        await outbox.text(invoice.to, `${merchant.name}: friendly reminder, ${format(invoice.total)}`);
        await deliverInvoice(deps, invoice, merchant);
        await store.markInvoiceReminded(invoice.id);
        return `Reminder sent for ${invoice.code} (${format(invoice.total)}) to ${invoice.to.phone}.`;
      },
      calls,
    ),
    defineTool(
      "cancel_invoice",
      "Cancel an open invoice or one-time code so it can't be paid.",
      MerchantToolInputs.cancel_invoice,
      async ({ code }) => {
        const invoice = await store.getInvoiceByCode(code.trim().toUpperCase());
        if (!invoice || invoice.merchantId !== merchant.id) throw new ToolError(`No invoice ${code}.`);
        if (invoice.status !== "open") throw new ToolError(`${invoice.code} is already ${invoice.status}.`);
        const ok = await store.cancelInvoice(invoice.code);
        return ok ? `Cancelled ${invoice.code} (${format(invoice.total)}).` : `Couldn't cancel ${invoice.code}; it may have just been paid.`;
      },
      calls,
    ),
  ];
}
