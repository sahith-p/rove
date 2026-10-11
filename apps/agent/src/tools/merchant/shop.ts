// Merchant tools: shop profile, menu, contacts, and the merchant-page cards (setup, bank, my shop).

import { format, MerchantToolInputs, type MenuItem } from "@rove/shared";
import { defineTool, ToolError } from "../../agent/tool";
import type { ToolContext } from "../context";
import { matchByName } from "../match";
import { parseAmount } from "../pricing";
import { requireMerchant } from "./util";

const menuLine = (items: MenuItem[]) => (items.length ? items.map((i) => `${i.name} ${format(i.price)}`).join(", ") : "(empty)");

export function shopTools(ctx: ToolContext) {
  const { deps, from, calls } = ctx;
  const merchant = requireMerchant(ctx);
  const { store, outbox, builders } = deps;

  return [
    defineTool(
      "set_shop_profile",
      "Change the shop's display name and/or category.",
      MerchantToolInputs.set_shop_profile,
      async ({ name, category }) => {
        if (!name && category === undefined) throw new ToolError("Nothing to change: give a new name or category.");
        const m = await store.updateShop(merchant.id, { ...(name ? { name } : {}), ...(category !== undefined ? { category } : {}) });
        return `Shop updated: ${m.name}${m.category ? ` (${m.category})` : ""}. Shop code stays ${m.id}.`;
      },
      calls,
    ),
    defineTool(
      "open_shop_setup",
      "Send the shop setup card where the merchant edits name, category and menu.",
      MerchantToolInputs.open_shop_setup,
      async () => {
        const menu = await store.listMenu(merchant.id);
        await outbox.cards.send(from, builders.setup({ merchant, menu, sessionToken: deps.sessionToken(merchant.id, "setup") }));
        return "Setup card sent.";
      },
      calls,
    ),
    defineTool(
      "add_menu_items",
      "Add menu items (or change the price of existing ones with the same name). Prices are decimal strings like \"5.50\".",
      MerchantToolInputs.add_menu_items,
      async ({ items }) => {
        const saved: MenuItem[] = [];
        for (const item of items) {
          const price = parseAmount(item.price, merchant.currency);
          if (!price || price.amount === "0.00") throw new ToolError(`"${item.price}" isn't a valid price for ${item.name}.`);
          saved.push(await store.upsertMenuItem(merchant.id, { name: item.name.trim(), price, active: true }));
        }
        const menu = await store.listMenu(merchant.id);
        return `Saved: ${menuLine(saved)}. Menu now has ${menu.length} item${menu.length === 1 ? "" : "s"}.`;
      },
      calls,
    ),
    defineTool(
      "update_menu_item",
      "Change a menu item's price, or remove it (remove: true).",
      MerchantToolInputs.update_menu_item,
      async ({ name, price, remove }) => {
        const menu = await store.listMenu(merchant.id);
        const m = matchByName(name, menu, (i) => i.name);
        if (m.kind === "none") throw new ToolError(`No menu item like "${name}". Menu: ${menuLine(menu)}.`);
        if (m.kind === "many") throw new ToolError(`Which one: ${m.items.map((i) => i.name).join(" or ")}?`);
        const item = m.item;
        if (remove) {
          await store.upsertMenuItem(merchant.id, { name: item.name, price: item.price, active: false });
          return `Removed ${item.name} from the menu.`;
        }
        if (!price) throw new ToolError("Give a new price, or say remove.");
        const p = parseAmount(price, merchant.currency);
        if (!p || p.amount === "0.00") throw new ToolError(`"${price}" isn't a valid price.`);
        const saved = await store.upsertMenuItem(merchant.id, { name: item.name, price: p, active: true });
        return `${saved.name} is now ${format(saved.price)}.`;
      },
      calls,
    ),
    defineTool(
      "show_menu",
      "Send the merchant their menu card and list the items with prices.",
      MerchantToolInputs.show_menu,
      async () => {
        const menu = await store.listMenu(merchant.id);
        if (menu.length) await outbox.cards.send(from, builders.menu({ merchant, menu }));
        return `Menu: ${menuLine(menu)}.${menu.length ? " Menu card sent." : " Add items like 'chicken rice 5.50'."}`;
      },
      calls,
    ),
    defineTool(
      "add_contact",
      "Save a customer contact (name + phone in E.164, e.g. +6591234567).",
      MerchantToolInputs.add_contact,
      async ({ name, phone }) => {
        const c = await store.addContact(merchant.id, { name: name.trim(), phone, channel: null });
        return `Saved contact ${c.name} (${c.phone}).`;
      },
      calls,
    ),
    defineTool(
      "list_contacts",
      "List saved customer contacts, optionally filtered by a name.",
      MerchantToolInputs.list_contacts,
      async ({ query }) => {
        const contacts = await store.findContacts(merchant.id, query);
        if (!contacts.length) return query ? `No contacts matching "${query}".` : "No contacts saved yet.";
        return contacts.map((c) => `${c.name} ${c.phone}`).join("; ");
      },
      calls,
    ),
    defineTool(
      "open_bank_setup",
      "Send the secure bank details card. Use whenever the merchant wants to add or change their bank, or pastes bank numbers in chat. Never collect bank numbers in chat.",
      MerchantToolInputs.open_bank_setup,
      async () => {
        await outbox.cards.send(from, builders.bank({ merchant, sessionToken: deps.sessionToken(merchant.id, "bank") }));
        return "Secure bank card sent (link valid 15 minutes). Bank details go in the card, not the chat.";
      },
      calls,
    ),
    defineTool(
      "open_my_shop",
      "Send the 'my shop' page card (balance, payments, invoices, contacts, menu).",
      MerchantToolInputs.open_my_shop,
      async () => {
        await outbox.cards.send(from, builders.shop({ merchant, sessionToken: deps.sessionToken(merchant.id, "shop") }));
        return "My shop card sent.";
      },
      calls,
    ),
  ];
}
