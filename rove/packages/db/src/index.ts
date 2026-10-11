// Typed data access for every service. Owner: Nithya (task NI-B1).
// Server-side only (service role key). Map snake_case rows ↔ camelCase domain types here, nowhere else.
//
// Planned surface (implement in NI-B1; other owners request additions in tasks/integration.md):
//   merchants:  getMerchant(id) · getMerchantByPhone(phone) · findShop(query) ← shop code, then phone, then fuzzy name
//               upsertDraftMerchant(m) · updateShop(id, patch) · setAutoWithdraw(id, mode)
//   menu:       listMenu(merchantId) · replaceMenu(merchantId, items) · upsertMenuItem(merchantId, item) · findMenuItems(merchantId, names[])
//   contacts:   addContact(merchantId, {name, phone, channel}) · findContacts(merchantId, query) · getContactByName(merchantId, name)
//   invoices:   createInvoice(i) (kinds: invoice | one_time_qr | pay_request) · getInvoiceByCode(code) · listInvoices(merchantId, status) · openInvoicesForPhone(phone)
//               markInvoicePaid(id, paymentId) · cancelInvoice(code) · expireInvoices()
//   payments:   insertPayment(p) · getPayment(id) · getPaymentByStripePI(pi) · getPaymentByDepositAddress(addr)
//               transitionPayment(id, from[], to, patch) ← compare-and-set on status, returns boolean
//               listPayments(merchantId, limit) · receiptsForPhone(phone, limit) · daySummary(merchantId, date)
//   ledger:     appendLedger(entry) (unique (kind, ref) → idempotent) · getBalance(merchantId)  ← merchant_balances view
//   bank:       insertBankAccount(b) · listBankAccounts(merchantId) · getDefaultBankAccount(merchantId)
//   withdrawals: insertWithdrawal(w) · getWithdrawal(id) · transitionWithdrawal(id, from[], to, patch) · listWithdrawals(merchantId)
//   refunds:    insertRefund(r) · updateRefund(id, patch)
//   actions:    insertAction(a) · getAction(id) · findOpenActionByMessageId(msgId) · findOpenActionsForMerchant(merchantId)
//               claimAction(id) ← UPDATE ... SET status='executing' WHERE status='proposed' AND expires_at > now()
//   agent:      appendAgentMessage(m) · recentAgentMessages(phone, limit) · getOnboarding(phone) · setOnboarding(phone, step, data)
//   plumbing:   claim(key) → boolean (SQL function) · insertEvent(envelope)

export {};
