// Demo data for mocks, seeds, evals and UI work. Replace phones with the real demo phones.

import { money } from "../money";
import type { Contact, Invoice, MenuItem, Merchant, Payment } from "../domain";

export const DEMO_MERCHANT: Merchant = {
  id: "ahseng",
  name: "Ah Seng Chicken Rice",
  phone: "+15555550100", // ← merchant demo iPhone (iMessage)
  channel: "imessage",
  category: "hawker",
  country: "SG",
  currency: "SGD",
  xrplAddress: null,
  credentialStatus: "none",
  autoWithdraw: "off",
  status: "live",
  createdAt: new Date(0).toISOString(),
};

export const DEMO_CUSTOMER = { name: "Maya", phone: "+15555550199", channel: "imessage" as const }; // ← customer demo iPhone

export const DEMO_MENU: MenuItem[] = [
  { id: "item_chicken_rice", merchantId: "ahseng", name: "Chicken rice", price: money("5.50", "SGD"), active: true, sort: 1 },
  { id: "item_roasted", merchantId: "ahseng", name: "Roasted chicken rice", price: money("6.00", "SGD"), active: true, sort: 2 },
  { id: "item_egg", merchantId: "ahseng", name: "Add egg", price: money("1.00", "SGD"), active: true, sort: 3 },
  { id: "item_barley", merchantId: "ahseng", name: "Barley drink", price: money("1.50", "SGD"), active: true, sort: 4 },
];

export const DEMO_CONTACTS: Contact[] = [
  { id: "ct_maya", merchantId: "ahseng", name: DEMO_CUSTOMER.name, phone: DEMO_CUSTOMER.phone, channel: "imessage", createdAt: new Date(0).toISOString() },
];

export function demoInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_demo0001",
    code: "K7Q2MX",
    merchantId: "ahseng",
    kind: "invoice",
    contactId: "ct_maya",
    to: { phone: DEMO_CUSTOMER.phone, channel: "imessage" },
    lines: [
      { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
      { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
    ],
    total: money("12.50", "SGD"),
    note: null,
    status: "open",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    paymentId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function demoPayment(overrides: Partial<Payment> = {}): Payment {
  const now = new Date().toISOString();
  return {
    id: "pay_demo0001",
    merchantId: "ahseng",
    source: "invoice",
    invoiceId: "inv_demo0001",
    lines: demoInvoice().lines,
    local: money("12.50", "SGD"),
    quote: null,
    method: "apple_pay",
    status: "settled",
    payer: { phone: DEMO_CUSTOMER.phone, channel: "imessage" },
    refunded: money("0", "SGD"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
