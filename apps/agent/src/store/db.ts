// Store over @rove/db (Nithya, NI-B1): the real Postgres (Supabase via DATABASE_URL) shared with the worker and web.
// Every method maps onto a @rove/db helper; the few renames are noted inline.

import { createDb, type Db } from "@rove/db";
import type { OnboardingState, Store } from "../ports";

export function createDbStore(db: Db = createDb()): Store {
  return {
    // merchants
    getMerchant: (id) => db.getMerchant(id),
    getMerchantByPhone: (phone) => db.getMerchantByPhone(phone),
    async findShop(query) {
      const r = await db.findShop(query);
      return r.merchant ? [r.merchant] : r.candidates;
    },
    upsertDraftMerchant: (m) => db.upsertDraftMerchant(m),
    async updateShop(id, patch) {
      const m = await db.updateShop(id, patch);
      if (!m) throw new Error(`updateShop: no merchant ${id}`);
      return m;
    },
    listLiveMerchants: () => db.listLiveMerchants(),

    // menu
    listMenu: (merchantId) => db.listMenu(merchantId),
    upsertMenuItem: (merchantId, item) => db.upsertMenuItem(merchantId, item),

    // contacts
    addContact: (merchantId, c) => db.addContact(merchantId, c),
    findContacts: (merchantId, query) => db.findContacts(merchantId, query),

    // invoices
    createInvoice: (i) => db.createInvoice(i),
    getInvoice: (id) => db.getInvoice(id),
    getInvoiceByCode: (code) => db.getInvoiceByCode(code),
    listInvoices: (merchantId, status) => db.listInvoices(merchantId, status),
    openInvoicesForPhone: (phone) => db.openInvoicesForPhone(phone),
    async cancelInvoice(code) {
      const invoice = await db.getInvoiceByCode(code);
      return invoice ? db.cancelInvoice(invoice.merchantId, code) : false;
    },
    invoicesDueForReminder: (createdBefore) => db.invoicesToRemind(new Date(createdBefore)),
    markInvoiceReminded: (id) => db.markInvoiceReminded(id), // CAS on reminded_at: one nudge per invoice

    // payments + ledger
    getPayment: (id) => db.getPayment(id),
    listPayments: (merchantId, limit) => db.listPayments(merchantId, limit),
    async receiptsForPhone(phone, limit) {
      const payments = await db.receiptsForPhone(phone, limit);
      const names = new Map<string, string>();
      for (const id of new Set(payments.map((p) => p.merchantId))) names.set(id, (await db.getMerchant(id))?.name ?? id);
      return payments.map((p) => ({ ...p, merchantName: names.get(p.merchantId) ?? p.merchantId }));
    },
    daySummary: (merchantId, date) => db.daySummary(merchantId, date),
    getBalance: (merchantId) => db.getBalance(merchantId),

    // bank + withdrawals
    getDefaultBankAccount: (merchantId) => db.getDefaultBankAccount(merchantId),
    getWithdrawal: (id) => db.getWithdrawal(id),

    // pending actions
    insertAction: (a) => db.insertAction({ merchantId: a.merchantId, args: a.args, expiresAt: a.expiresAt }),
    getAction: (id) => db.getAction(id),
    setActionMessageIds: (id, messageIds) => db.addConfirmMessageIds(id, messageIds),
    findActionByMessageId: (messageId) => db.findActionByMessageId(messageId), // any status, so a late 👍 hears "expired"
    findOpenActionsForMerchant: (merchantId) => db.findOpenActionsForMerchant(merchantId),
    async claimAction(id) {
      return (await db.claimAction(id)) !== null;
    },
    async finishAction(id, status, result) {
      await db.setActionStatus(id, status, result);
    },
    expireActions: () => db.expireActions(),
    findActionByRef: (ref) => db.findActionByRef(ref),

    // agent memory + onboarding
    appendAgentMessage: (m) => db.appendAgentMessage(m),
    recentAgentMessages: (phone, limit) => db.recentAgentMessages(phone, limit),
    async getOnboarding(phone) {
      return (await db.getOnboarding(phone)) as OnboardingState | null;
    },
    async setOnboarding(phone, channel, step, data) {
      await db.setOnboarding(phone, channel, step, data);
      return (await db.getOnboarding(phone)) as OnboardingState;
    },

    // plumbing
    claim: (key) => db.claim(key),
  };
}
