// The agent's tool surface (Saran implements these in apps/agent/src/tools).
// One agent, two personas: the sender's phone decides. Registered merchant → merchant tools; anyone else → customer
// tools (plus "start" to open a shop). Input schemas are shared so evals and the web app agree on shapes.
// RULE: no tool moves money. propose_* tools create a PendingAction and send a confirm card / ask for YES.

import { z } from "zod";
import { Decimal, E164 } from "./api";

const ItemRef = z.object({ name: z.string().describe("Menu item name as the merchant said it"), qty: z.number().int().positive().default(1) });

export const MerchantToolInputs = {
  // --- shop setup (also doable in the setup card)
  set_shop_profile: z.object({ name: z.string().min(2).max(60).optional(), category: z.string().max(40).optional() }),
  open_shop_setup: z.object({}).describe("Send the setup card (iMessage app) / link to edit name, category and menu"),
  add_menu_items: z.object({ items: z.array(z.object({ name: z.string().min(1).max(60), price: Decimal })).min(1).max(20) }),
  update_menu_item: z.object({ name: z.string(), price: Decimal.optional(), remove: z.boolean().optional() }),
  show_menu: z.object({}),
  // --- contacts
  add_contact: z.object({ name: z.string().min(1).max(60), phone: E164 }),
  list_contacts: z.object({ query: z.string().optional() }),
  // --- getting paid
  create_invoice: z.object({
    to: z.object({ contactName: z.string().optional(), phone: E164.optional() }).describe("Who to text the invoice to"),
    items: z.array(ItemRef).optional(),
    amount: Decimal.optional().describe("Use when there are no menu items"),
    note: z.string().max(120).optional(),
  }),
  create_one_time_qr: z.object({ items: z.array(ItemRef).optional(), amount: Decimal.optional(), note: z.string().max(120).optional() }),
  get_fixed_qr: z.object({}).describe("The shop's permanent QR sticker: payer enters an amount or picks from the menu"),
  list_invoices: z.object({ status: z.enum(["open", "paid", "all"]).default("open") }),
  remind_invoice: z.object({ code: z.string() }),
  cancel_invoice: z.object({ code: z.string() }),
  // --- money
  get_sales: z.object({ range: z.enum(["today", "yesterday", "7d"]) }),
  list_payments: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
  get_balance: z.object({}),
  open_bank_setup: z.object({}).describe("Send the secure bank details card / link. Never collect bank numbers in chat."),
  propose_withdrawal: z.object({
    amount: Decimal.optional().describe("Omit to withdraw everything available"),
    to: z.enum(["bank", "wallet"]).default("bank"),
    walletAddress: z.string().optional().describe("Required when to = wallet (XRPL address)"),
  }),
  set_auto_withdraw: z.object({ mode: z.enum(["off", "daily"]) }),
  propose_refund: z.object({ paymentId: z.string(), amount: Decimal.optional(), reason: z.string().max(200) }),
  open_my_shop: z.object({}).describe("Send the minimal 'my shop' page card / link"),
} as const;

export const CustomerToolInputs = {
  my_open_invoices: z.object({}),
  pay_invoice: z.object({ code: z.string() }).describe("Re-send the pay card for an invoice addressed to this customer"),
  my_receipts: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  find_shop: z.object({ query: z.string() }).describe("Look up a Rove shop by name to pay it (sends its fixed-QR page)"),
  start_shop: z.object({}).describe("The customer wants to open their own shop: begin merchant onboarding"),
} as const;

export type MerchantToolName = keyof typeof MerchantToolInputs;
export type CustomerToolName = keyof typeof CustomerToolInputs;

export const AGENT_MODEL = "claude-opus-5-5";
