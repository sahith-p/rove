// Demo-only MeRes for /shop while GET /api/me is unimplemented (NEXT_PUBLIC_DEMO_FIXTURES=1). SERVER ONLY.
// Built from @rove/shared/mocks so names, menu and prices match the rest of the demo. Validated with MeRes.parse.
import { MeRes, add, money } from "@rove/shared";
import { DEMO_CONTACTS, DEMO_MENU, DEMO_MERCHANT, demoInvoice, demoPayment } from "@rove/shared/mocks";
import type { z } from "zod";

export type MeData = z.infer<typeof MeRes>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function shopFixture(now: number = Date.now()): MeData {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const sgd = (a: string) => money(a, "SGD");

  const available = sgd("118.40");
  const held = sgd("50.00");

  const payments: [string, string, MeData["recentPayments"][number]["source"], MeData["recentPayments"][number]["status"], number][] = [
    ["pay_demo0010", "6.50", "one_time_qr", "settling", 40 * 1000],
    ["pay_demo0009", "12.50", "invoice", "settled", 7 * MIN],
    ["pay_demo0008", "11.00", "fixed_qr", "settled", 26 * MIN],
    ["pay_demo0007", "5.50", "fixed_qr", "settled", 52 * MIN],
    ["pay_demo0006", "20.00", "pay_request", "settled", 2 * HOUR],
    ["pay_demo0005", "7.00", "fixed_qr", "refunded", 3 * HOUR],
    ["pay_demo0004", "13.00", "invoice", "settled", 5 * HOUR],
    ["pay_demo0003", "6.00", "one_time_qr", "settled", 21 * HOUR],
    ["pay_demo0002", "4.50", "fixed_qr", "failed", 26 * HOUR],
    ["pay_demo0001", "16.50", "fixed_qr", "partially_refunded", 2 * DAY],
  ];

  const invoiceA = demoInvoice({ createdAt: ago(18 * MIN) });
  const invoiceB = demoInvoice({ code: "P4V8NB", total: sgd("33.00"), createdAt: ago(26 * HOUR) });
  const invoiceC = demoInvoice({ code: "H2DRZ6", total: sgd("6.50"), createdAt: ago(3 * HOUR) });

  return MeRes.parse({
    merchant: {
      id: DEMO_MERCHANT.id,
      name: DEMO_MERCHANT.name,
      category: DEMO_MERCHANT.category,
      currency: DEMO_MERCHANT.currency,
      status: DEMO_MERCHANT.status,
      autoWithdraw: DEMO_MERCHANT.autoWithdraw,
      verified: true,
    },
    balance: { available, held, total: add(available, held) },
    menu: [
      ...DEMO_MENU.map((m) => ({ id: m.id, name: m.name, price: m.price, active: m.active })),
      { id: "item_soup", name: "Soup of the day", price: sgd("2.00"), active: false },
    ],
    contacts: [
      ...DEMO_CONTACTS.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
      { id: "ct_wei", name: "Wei Ling", phone: "+6591234567" },
      { id: "ct_raj", name: "Raj (office lunch)", phone: "+6587654321" },
    ],
    openInvoices: [
      { code: invoiceA.code, to: DEMO_CONTACTS[0]?.name ?? "Maya", total: invoiceA.total, createdAt: invoiceA.createdAt },
      { code: invoiceC.code, to: null, total: invoiceC.total, createdAt: invoiceC.createdAt },
      { code: invoiceB.code, to: "Raj (office lunch)", total: invoiceB.total, createdAt: invoiceB.createdAt },
    ],
    recentPayments: payments.map(([id, amount, source, status, msAgo]) => {
      const p = demoPayment({ id, local: sgd(amount), source, status, createdAt: ago(msAgo) });
      return { id: p.id, local: p.local, status: p.status, source: p.source, createdAt: p.createdAt };
    }),
    bankAccounts: [
      { id: "ba_dbs", type: "bank_account", bankName: "DBS", last4: "1234", holderName: "AH SENG FOOD PTE LTD", status: "verified", isDefault: true },
    ],
    withdrawals: [
      {
        id: "wd_demo0003",
        amount: held,
        fee: sgd("0"),
        destination: { kind: "bank", label: "DBS ••••1234" },
        status: "payout_pending",
        needsStepUp: false,
        updatedAt: ago(2 * MIN),
      },
      {
        id: "wd_demo0002",
        amount: sgd("20.00"),
        fee: sgd("0"),
        destination: { kind: "xrpl_wallet", label: "rP4x…9Kd" },
        status: "completed",
        needsStepUp: false,
        updatedAt: ago(DAY + 3 * HOUR),
      },
      {
        id: "wd_demo0001",
        amount: sgd("86.20"),
        fee: sgd("0"),
        destination: { kind: "bank", label: "DBS ••••1234" },
        status: "completed",
        bankRef: "FAST-881245",
        needsStepUp: true,
        updatedAt: ago(3 * DAY),
      },
    ],
  });
}
