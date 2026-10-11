// Store over @rove/db (Nithya, NI-B1): the real Postgres (Supabase via DATABASE_URL) shared with the worker and web.
// Most methods map 1:1. Two lookups @rove/db doesn't have yet are covered by an in-process index this agent fills as it
// goes (it is the only writer of pending actions):
//   - findActionByMessageId (any status, so a late 👍 can say "expired"): falls back to findOpenActionByMessageId
//   - findActionByRef (withdrawal id / payment id → its action): indexed at insertAction
// After an agent restart those fall back to "open actions only" / "not found": a late 👍 is ignored instead of answered,
// and a withdrawal/refund confirmed before the restart doesn't get its confirm card edited. Money is unaffected.

import { createDb, type Db } from "@rove/db";
import type { PendingAction } from "@rove/shared";
import type { OnboardingState, Store } from "../ports";

export function createDbStore(db: Db = createDb()): Store {
  const actionByMessage = new Map<string, string>(); // confirm message id → action id
  const actionByRef = new Map<string, string>(); // withdrawal id / payment id → latest action id

  const refOf = (a: PendingAction): string | null =>
    a.args.kind === "withdrawal" ? a.args.withdrawalId : a.args.kind === "refund" ? a.args.paymentId : null;

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
    async markInvoiceReminded(id) {
      // @rove/db's setInvoiceReminded isn't a CAS; claim() makes the nudge exactly-once.
      if (!(await db.claim(`remind:${id}`))) return false;
      await db.setInvoiceReminded(id);
      return true;
    },

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
    async insertAction(a) {
      const action = await db.insertAction({ merchantId: a.merchantId, args: a.args, expiresAt: a.expiresAt });
      const ref = refOf(action);
      if (ref) actionByRef.set(ref, action.id);
      return action;
    },
    getAction: (id) => db.getAction(id),
    async setActionMessageIds(id, messageIds) {
      for (const m of messageIds) actionByMessage.set(m, id);
      await db.addConfirmMessageIds(id, messageIds);
    },
    async findActionByMessageId(messageId) {
      const known = actionByMessage.get(messageId);
      if (known) return db.getAction(known);
      return db.findOpenActionByMessageId(messageId);
    },
    findOpenActionsForMerchant: (merchantId) => db.findOpenActionsForMerchant(merchantId),
    async claimAction(id) {
      return (await db.claimAction(id)) !== null;
    },
    async finishAction(id, status, result) {
      await db.setActionStatus(id, status, result);
    },
    expireActions: () => db.expireActions(),
    async findActionByRef(ref) {
      const id = actionByRef.get(ref);
      return id ? db.getAction(id) : null;
    },

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
