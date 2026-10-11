// In-memory Store seeded with the demo fixtures (offline dev + evals). Owner: Saran.
// Mirrors the semantics of packages/db/schema.sql: ledger-derived balances, CAS on pending actions,
// processed-key idempotency. `mock` exposes the writes the mock worker needs.
//
// Seed: ahseng (live, menu from DEMO_MENU, contact Maya), two settled payments (S$12.50 + S$8.00 → S$20.50
// available), open one-time code K7Q2MX (S$6.50, 30 min), open invoice M4YA22 to Maya (S$6.50), and a second
// live shop kopi-uncle (Uncle's Kopi) for merchant-pays-another-shop. No bank account.

import {
  add,
  cmp,
  isPositive,
  money,
  newId,
  newShortCode,
  sub,
  zero,
  type ActionId,
  type AgentMessage,
  type Balance,
  type BankAccount,
  type Channel,
  type Contact,
  type Currency,
  type DaySummary,
  type Invoice,
  type LedgerEntry,
  type MenuItem,
  type Merchant,
  type Money,
  type Payment,
  type PendingAction,
  type Withdrawal,
} from "@rove/shared";
import { DEMO_CONTACTS, DEMO_CUSTOMER, DEMO_MENU, DEMO_MERCHANT, demoPayment } from "@rove/shared/mocks";
import type { MockStoreHooks, NewInvoice, OnboardingState, Store } from "../ports";
import { matchByName, normalize, toE164 } from "../tools/match";
import { localDate } from "../time";


const clone = <T>(v: T): T => structuredClone(v);

export function createMemoryStore(opts: { now: () => Date }): Store {
  const now = opts.now;
  const iso = () => now().toISOString();

  const merchants = new Map<string, Merchant>();
  const menu = new Map<string, MenuItem>(); // id → item
  const contacts = new Map<string, Contact>();
  const invoices = new Map<string, Invoice>();
  const remindedAt = new Map<string, string>();
  const payments = new Map<string, Payment>();
  const ledger: LedgerEntry[] = [];
  const banks = new Map<string, BankAccount>();
  const withdrawals = new Map<string, Withdrawal>();
  const actions = new Map<string, PendingAction>();
  const agentMessages: AgentMessage[] = [];
  const onboarding = new Map<string, OnboardingState>();
  const processed = new Set<string>();

  // ---------------------------------------------------------------- seed
  const seedAt = new Date(now().getTime() - 2 * 3600 * 1000).toISOString();
  merchants.set(DEMO_MERCHANT.id, {
    ...clone(DEMO_MERCHANT),
    xrplAddress: "rDemoAhSeng1111111111111111111111",
    credentialStatus: "accepted",
    status: "live",
    createdAt: seedAt,
  });
  for (const item of DEMO_MENU) menu.set(item.id, clone(item));
  for (const c of DEMO_CONTACTS) contacts.set(c.id, { ...clone(c), createdAt: seedAt });

  merchants.set("kopi-uncle", {
    id: "kopi-uncle",
    name: "Uncle's Kopi",
    phone: "+6590001111",
    channel: "imessage",
    category: "drinks",
    country: "SG",
    currency: "SGD",
    xrplAddress: "rDemoKopiUncle111111111111111111",
    credentialStatus: "accepted",
    autoWithdraw: "off",
    status: "live",
    createdAt: seedAt,
  });
  menu.set("item_kopi", { id: "item_kopi", merchantId: "kopi-uncle", name: "Kopi", price: money("1.80", "SGD"), active: true, sort: 1 });
  menu.set("item_teh", { id: "item_teh", merchantId: "kopi-uncle", name: "Teh", price: money("1.60", "SGD"), active: true, sort: 2 });

  const p1 = demoPayment({ status: "settled", createdAt: seedAt, updatedAt: seedAt });
  payments.set(p1.id, p1);
  const p2: Payment = {
    id: "pay_demo0002",
    merchantId: DEMO_MERCHANT.id,
    source: "fixed_qr",
    invoiceId: null,
    lines: [],
    local: money("8.00", "SGD"),
    quote: null,
    method: "card",
    status: "settled",
    payer: { phone: "+6591112222", channel: "imessage" },
    refunded: money("0", "SGD"),
    createdAt: seedAt,
    updatedAt: seedAt,
  };
  payments.set(p2.id, p2);
  ledger.push(
    { id: newId("led"), merchantId: DEMO_MERCHANT.id, kind: "payment_credit", amount: p1.local, ref: p1.id, createdAt: seedAt },
    { id: newId("led"), merchantId: DEMO_MERCHANT.id, kind: "payment_credit", amount: p2.local, ref: p2.id, createdAt: seedAt },
  );

  const seedInvoice = (i: Omit<Invoice, "id" | "createdAt" | "paymentId" | "status">) => {
    const inv: Invoice = { ...i, id: newId("inv"), status: "open", paymentId: null, createdAt: iso() };
    invoices.set(inv.id, inv);
  };
  seedInvoice({
    code: "K7Q2MX",
    merchantId: DEMO_MERCHANT.id,
    kind: "one_time_qr",
    contactId: null,
    to: null,
    lines: [{ menuItemId: null, name: "Payment", qty: 1, unit: money("6.50", "SGD") }],
    total: money("6.50", "SGD"),
    note: null,
    expiresAt: new Date(now().getTime() + 30 * 60 * 1000).toISOString(),
  });
  seedInvoice({
    code: "M4YA22",
    merchantId: DEMO_MERCHANT.id,
    kind: "invoice",
    contactId: "ct_maya",
    to: { phone: DEMO_CUSTOMER.phone, channel: "imessage" },
    lines: [
      { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 1, unit: money("5.50", "SGD") },
      { menuItemId: "item_egg", name: "Add egg", qty: 1, unit: money("1.00", "SGD") },
    ],
    total: money("6.50", "SGD"),
    note: null,
    expiresAt: new Date(now().getTime() + 7 * 24 * 3600 * 1000).toISOString(),
  });

  // ---------------------------------------------------------------- helpers
  const currencyOf = (merchantId: string): Currency => merchants.get(merchantId)?.currency ?? "SGD";

  const balanceOf = (merchantId: string): Balance => {
    const c = currencyOf(merchantId);
    let available = zero(c);
    let held = zero(c);
    for (const e of ledger) {
      if (e.merchantId !== merchantId) continue;
      switch (e.kind) {
        case "payment_credit":
        case "withdrawal_return":
          available = add(available, e.amount);
          break;
        case "withdrawal_release":
          available = add(available, e.amount);
          held = sub(held, e.amount);
          break;
        case "refund_debit":
          available = sub(available, e.amount);
          break;
        case "withdrawal_hold":
          available = sub(available, e.amount);
          held = add(held, e.amount);
          break;
        case "withdrawal_debit":
          held = sub(held, e.amount);
          break;
      }
    }
    return { available, held, total: add(available, held) };
  };

  const isOpen = (i: Invoice) => i.status === "open" && new Date(i.expiresAt).getTime() > now().getTime();

  const refreshExpiry = (i: Invoice): Invoice => {
    if (i.status === "open" && new Date(i.expiresAt).getTime() <= now().getTime()) i.status = "expired";
    return i;
  };

  const requireMerchant = (id: string): Merchant => {
    const m = merchants.get(id);
    if (!m) throw new Error(`unknown merchant ${id}`);
    return m;
  };

  const sortedMenu = (merchantId: string) =>
    [...menu.values()].filter((i) => i.merchantId === merchantId && i.active).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  const settledLike = (p: Payment) => p.status === "settled" || p.status === "partially_refunded" || p.status === "refunded";

  // ---------------------------------------------------------------- mock hooks
  const mock: MockStoreHooks = {
    async setMerchantLive(id, xrplAddress) {
      const m = requireMerchant(id);
      m.status = "live";
      m.xrplAddress = xrplAddress;
      m.credentialStatus = "accepted";
    },
    async appendLedger(e) {
      if (ledger.some((x) => x.kind === e.kind && x.ref === e.ref)) return; // unique (kind, ref)
      ledger.push({ ...clone(e), id: newId("led"), createdAt: iso() });
    },
    async insertWithdrawal(w) {
      withdrawals.set(w.id, clone(w));
    },
    async updateWithdrawal(id, patch) {
      const w = withdrawals.get(id);
      if (!w) throw new Error(`unknown withdrawal ${id}`);
      Object.assign(w, clone(patch), { updatedAt: iso() });
      return clone(w);
    },
    async updatePayment(id, patch) {
      const p = payments.get(id);
      if (!p) throw new Error(`unknown payment ${id}`);
      Object.assign(p, clone(patch), { updatedAt: iso() });
      return clone(p);
    },
    async setAutoWithdraw(id, mode) {
      requireMerchant(id).autoWithdraw = mode;
    },
    async addBankAccount(b) {
      for (const x of banks.values()) if (x.merchantId === b.merchantId && b.isDefault) x.isDefault = false;
      const bank: BankAccount = { ...clone(b), id: newId("bank"), createdAt: iso() };
      banks.set(bank.id, bank);
      return clone(bank);
    },
    async payInvoice(code, payer) {
      const inv = [...invoices.values()].find((i) => i.code === code.toUpperCase());
      if (!inv) throw new Error(`unknown invoice ${code}`);
      if (!isOpen(inv)) throw new Error(`invoice ${code} is ${refreshExpiry(inv).status}`);
      const at = iso();
      const p: Payment = {
        id: newId("pay"),
        merchantId: inv.merchantId,
        source: inv.kind,
        invoiceId: inv.id,
        lines: clone(inv.lines),
        local: clone(inv.total),
        quote: null,
        method: "apple_pay",
        status: "settled",
        payer: payer ?? inv.to,
        settleTxHash: "0".repeat(64),
        deliveredAmount: inv.total.amount,
        refunded: zero(inv.total.currency),
        createdAt: at,
        updatedAt: at,
      };
      payments.set(p.id, p);
      inv.status = "paid";
      inv.paymentId = p.id;
      await mock.appendLedger({ merchantId: p.merchantId, kind: "payment_credit", amount: p.local, ref: p.id });
      return clone(p);
    },
  };

  // ---------------------------------------------------------------- store
  const store: Store = {
    mock,

    // merchants
    async getMerchant(id) {
      const m = merchants.get(id);
      return m ? clone(m) : null;
    },
    async getMerchantByPhone(phone) {
      const m = [...merchants.values()].find((x) => x.phone === phone);
      return m ? clone(m) : null;
    },
    async findShop(query) {
      const live = [...merchants.values()].filter((m) => m.status === "live");
      const q = query.trim().toLowerCase();
      const byCode = live.find((m) => m.id === q || m.id === q.replace(/\s+/g, "-") || m.id.replace(/-/g, "") === q.replace(/[\s-]+/g, ""));
      if (byCode) return [clone(byCode)];
      const phone = toE164(query);
      if (phone) {
        const byPhone = live.find((m) => m.phone === phone);
        if (byPhone) return [clone(byPhone)];
      }
      if (!normalize(query)) return [];
      const r = matchByName(query, live, (m) => m.name);
      if (r.kind === "one") return [clone(r.item)];
      if (r.kind === "many") return r.items.map(clone);
      return [];
    },
    async upsertDraftMerchant(m) {
      const existing = merchants.get(m.id);
      if (existing && existing.phone !== m.phone) throw new Error(`shop code ${m.id} is taken`);
      const merged: Merchant = existing
        ? { ...existing, name: m.name, category: m.category, channel: m.channel }
        : {
            id: m.id,
            name: m.name,
            phone: m.phone,
            channel: m.channel,
            category: m.category,
            country: m.country ?? "SG",
            currency: m.currency ?? "SGD",
            xrplAddress: null,
            credentialStatus: "none",
            autoWithdraw: "off",
            status: "draft",
            createdAt: iso(),
          };
      merchants.set(m.id, merged);
      return clone(merged);
    },
    async updateShop(id, patch) {
      const m = requireMerchant(id);
      if (patch.name !== undefined) m.name = patch.name;
      if (patch.category !== undefined) m.category = patch.category;
      return clone(m);
    },
    async listLiveMerchants() {
      return [...merchants.values()].filter((m) => m.status === "live").map(clone);
    },

    // menu
    async listMenu(merchantId) {
      return sortedMenu(merchantId).map(clone);
    },
    async upsertMenuItem(merchantId, item) {
      const key = normalize(item.name);
      const existing = [...menu.values()].find((i) => i.merchantId === merchantId && normalize(i.name) === key);
      if (existing) {
        existing.price = clone(item.price);
        existing.active = item.active ?? true;
        return clone(existing);
      }
      const sort = Math.max(0, ...[...menu.values()].filter((i) => i.merchantId === merchantId).map((i) => i.sort)) + 1;
      const created: MenuItem = { id: newId("item"), merchantId, name: item.name.trim(), price: clone(item.price), active: item.active ?? true, sort };
      menu.set(created.id, created);
      return clone(created);
    },

    // contacts
    async addContact(merchantId, c) {
      const existing = [...contacts.values()].find((x) => x.merchantId === merchantId && x.phone === c.phone);
      if (existing) {
        existing.name = c.name;
        if (c.channel) existing.channel = c.channel;
        return clone(existing);
      }
      const created: Contact = { id: newId("ct"), merchantId, name: c.name, phone: c.phone, channel: c.channel, createdAt: iso() };
      contacts.set(created.id, created);
      return clone(created);
    },
    async findContacts(merchantId, query) {
      const mine = [...contacts.values()].filter((c) => c.merchantId === merchantId);
      if (!query || !query.trim()) return mine.map(clone);
      const phone = toE164(query);
      if (phone) {
        const byPhone = mine.filter((c) => c.phone === phone);
        if (byPhone.length) return byPhone.map(clone);
      }
      const r = matchByName(query, mine, (c) => c.name);
      if (r.kind === "one") return [clone(r.item)];
      if (r.kind === "many") return r.items.map(clone);
      return [];
    },

    // invoices
    async createInvoice(i: NewInvoice) {
      if (!isPositive(i.total)) throw new Error("invoice total must be > 0");
      let code = newShortCode();
      while ([...invoices.values()].some((x) => x.code === code)) code = newShortCode();
      const inv: Invoice = { ...clone(i), id: newId("inv"), code, status: "open", paymentId: null, createdAt: iso() };
      invoices.set(inv.id, inv);
      return clone(inv);
    },
    async getInvoice(id) {
      const i = invoices.get(id);
      return i ? clone(refreshExpiry(i)) : null;
    },
    async getInvoiceByCode(code) {
      const i = [...invoices.values()].find((x) => x.code === code.trim().toUpperCase());
      return i ? clone(refreshExpiry(i)) : null;
    },
    async listInvoices(merchantId, status) {
      return [...invoices.values()]
        .filter((i) => i.merchantId === merchantId)
        .map(refreshExpiry)
        .filter((i) => status === "all" || i.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone);
    },
    async openInvoicesForPhone(phone) {
      return [...invoices.values()]
        .map(refreshExpiry)
        .filter((i) => i.status === "open" && i.to?.phone === phone)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone);
    },
    async cancelInvoice(code) {
      const i = [...invoices.values()].find((x) => x.code === code.trim().toUpperCase());
      if (!i || refreshExpiry(i).status !== "open") return false;
      i.status = "cancelled";
      return true;
    },
    async invoicesDueForReminder(createdBefore) {
      return [...invoices.values()]
        .map(refreshExpiry)
        .filter((i) => i.status === "open" && i.kind === "invoice" && !remindedAt.has(i.id) && i.createdAt < createdBefore)
        .map(clone);
    },
    async markInvoiceReminded(id) {
      if (remindedAt.has(id)) return false;
      remindedAt.set(id, iso());
      return true;
    },

    // payments + ledger
    async getPayment(id) {
      const p = payments.get(id);
      return p ? clone(p) : null;
    },
    async listPayments(merchantId, limit) {
      return [...payments.values()]
        .filter((p) => p.merchantId === merchantId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(clone);
    },
    async receiptsForPhone(phone, limit) {
      return [...payments.values()]
        .filter((p) => p.payer?.phone === phone && settledLike(p))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((p) => ({ ...clone(p), merchantName: merchants.get(p.merchantId)?.name ?? p.merchantId }));
    },
    async daySummary(merchantId, date): Promise<DaySummary> {
      const c = currencyOf(merchantId);
      let gross: Money = zero(c);
      let refunded: Money = zero(c);
      let count = 0;
      for (const p of payments.values()) {
        if (p.merchantId !== merchantId || !settledLike(p) || localDate(new Date(p.createdAt)) !== date) continue;
        count++;
        gross = add(gross, p.local);
        refunded = add(refunded, p.refunded);
      }
      const openInvoices = [...invoices.values()].map(refreshExpiry).filter((i) => i.merchantId === merchantId && i.status === "open").length;
      return { merchantId, date, count, gross, refunded, net: sub(gross, refunded), openInvoices };
    },
    async getBalance(merchantId) {
      return balanceOf(merchantId);
    },

    // bank + withdrawals
    async getDefaultBankAccount(merchantId) {
      const mine = [...banks.values()].filter((b) => b.merchantId === merchantId && b.status !== "failed");
      const b = mine.find((x) => x.isDefault) ?? mine[0];
      return b ? clone(b) : null;
    },
    async getWithdrawal(id) {
      const w = withdrawals.get(id);
      return w ? clone(w) : null;
    },

    // pending actions
    async insertAction(a) {
      const action: PendingAction = {
        id: newId("act"),
        merchantId: a.merchantId,
        kind: a.kind,
        args: clone(a.args),
        status: "proposed",
        confirmMessageIds: [],
        expiresAt: a.expiresAt,
        createdAt: iso(),
      };
      actions.set(action.id, action);
      return clone(action);
    },
    async getAction(id: ActionId) {
      const a = actions.get(id);
      return a ? clone(a) : null;
    },
    async setActionMessageIds(id, messageIds) {
      const a = actions.get(id);
      if (a) a.confirmMessageIds = [...messageIds];
    },
    async findActionByMessageId(messageId) {
      const found = [...actions.values()]
        .filter((a) => a.confirmMessageIds.includes(messageId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return found ? clone(found) : null;
    },
    async findOpenActionsForMerchant(merchantId) {
      const t = now().getTime();
      return [...actions.values()]
        .filter((a) => a.merchantId === merchantId && a.status === "proposed" && new Date(a.expiresAt).getTime() > t)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone);
    },
    async claimAction(id) {
      const a = actions.get(id);
      if (!a || a.status !== "proposed" || new Date(a.expiresAt).getTime() <= now().getTime()) return false;
      a.status = "executing";
      return true;
    },
    async finishAction(id, status, result) {
      const a = actions.get(id);
      if (!a) return;
      a.status = status;
      if (result !== undefined) a.result = clone(result);
    },
    async expireActions() {
      const t = now().getTime();
      const changed: PendingAction[] = [];
      for (const a of actions.values()) {
        if (a.status === "proposed" && new Date(a.expiresAt).getTime() <= t) {
          a.status = "expired";
          changed.push(clone(a));
        }
      }
      return changed;
    },
    async findActionByRef(ref) {
      const found = [...actions.values()]
        .filter((a) => (a.args.kind === "withdrawal" && a.args.withdrawalId === ref) || (a.args.kind === "refund" && a.args.paymentId === ref))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return found ? clone(found) : null;
    },

    // agent memory + onboarding
    async appendAgentMessage(m) {
      agentMessages.push({ ...clone(m), createdAt: iso() });
    },
    async recentAgentMessages(phone, limit) {
      return agentMessages.filter((m) => m.phone === phone).slice(-limit).map(clone);
    },
    async getOnboarding(phone) {
      const o = onboarding.get(phone);
      return o ? clone(o) : null;
    },
    async setOnboarding(phone, channel: Channel, step, data) {
      const o: OnboardingState = { phone, channel, step, data: clone(data), updatedAt: iso() };
      onboarding.set(phone, o);
      return clone(o);
    },

    // plumbing
    async claim(key) {
      if (processed.has(key)) return false;
      processed.add(key);
      return true;
    },
  };

  return store;
}

/** Remaining refundable amount on a payment. */
export function refundable(p: Payment): Money {
  const left = sub(p.local, p.refunded);
  return cmp(left, zero(left.currency)) < 0 ? zero(left.currency) : left;
}

