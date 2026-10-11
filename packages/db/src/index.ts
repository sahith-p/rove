// Typed data access for every service. Owner: Nithya (task NI-B1). Server-side only.
// Talks SQL directly to Postgres (Supabase in deploys via DATABASE_URL, the transaction pooler on Vercel;
// PGlite in tests via @rove/db/testing), so multi-step money changes run in one real transaction.
// Map snake_case rows ↔ camelCase domain types here, nowhere else. Money in and out is always `Money` (decimal strings).
//
// This file is the contract the worker, the web API and the agent build against. Other owners request additions in
// tasks/integration.md. Every status change is compare-and-set: it returns the updated row, or null if the row
// wasn't in one of the `from` statuses (someone else got there first).

import type {
  AgentMessage,
  AutoWithdraw,
  Balance,
  BankAccount,
  Channel,
  Contact,
  CredentialStatus,
  Currency,
  DaySummary,
  EventEnvelope,
  Invoice,
  InvoiceKind,
  InvoiceLine,
  LedgerKind,
  MenuItem,
  Merchant,
  MerchantId,
  Money,
  Payment,
  PaymentId,
  PaymentMethod,
  PaymentStatus,
  PendingAction,
  PendingActionStatus,
  Recipient,
  Refund,
  Withdrawal,
  WithdrawalId,
  WithdrawalStatus,
} from "@rove/shared";
import { postgresPool } from "./executor";
import { makeDb } from "./impl";

// ------------------------------------------------------------------ inputs

export interface NewDraftMerchant {
  id: MerchantId;
  name: string;
  phone: string;
  channel: Channel;
  category?: string | null;
  currency?: Currency; // default SGD
}

export interface MenuItemInput {
  id?: string; // keep the id when editing an existing row
  name: string;
  price: Money;
  active?: boolean; // default true
}

/** One requested name resolved against the menu: exact (case-insensitive) → prefix → fuzzy (Levenshtein ≤ 2). */
export interface MenuMatch {
  query: string;
  item: MenuItem | null;
  /** Closest names when there is no confident match, so the agent can ask "Did you mean …?" */
  suggestions: string[];
}

export interface ShopMatch {
  /** Confident single match: shop code, then merchant phone, then fuzzy name. */
  merchant: Merchant | null;
  /** Several plausible shops (ambiguous name): the agent asks which one. */
  candidates: Merchant[];
}

export interface NewInvoice {
  merchantId: MerchantId;
  kind: InvoiceKind;
  contactId?: string | null;
  to?: Recipient | null;
  lines: InvoiceLine[];
  total: Money; // computed by the caller from DB prices with money.ts; the DB re-checks Σ qty × unit
  note?: string | null;
  /** Default by kind: invoice 7 days, one_time_qr 30 minutes, pay_request 1 hour. */
  expiresAt?: string;
}

export interface NewPayment {
  id: PaymentId;
  merchantId: MerchantId;
  source: Payment["source"];
  invoiceId: string | null;
  lines: InvoiceLine[];
  local: Money;
  quote: Payment["quote"];
  charge: Money; // what the payer is charged, in their own currency (payments-stripe.md §1a)
  method: PaymentMethod;
  payer: Recipient | null;
  stripePaymentIntentId?: string;
  bnbDepositAddress?: string;
}

/** Fields a payment transition may set alongside the status. */
export interface PaymentPatch {
  method?: PaymentMethod;
  stripePaymentIntentId?: string;
  payinTxHash?: string;
  settleTxHash?: string;
  deliveredAmount?: string;
  failureReason?: string;
  quote?: Payment["quote"];
}

export interface NewWithdrawal {
  merchantId: MerchantId;
  amount: Money;
  fee: Money;
  destination: Withdrawal["destination"];
  needsStepUp: boolean;
}

export interface WithdrawalPatch {
  sweepTxHash?: string;
  partnerPayoutId?: string;
  bankRef?: string;
  failureReason?: string;
}

export interface NewBankAccount {
  merchantId: MerchantId;
  type: BankAccount["type"];
  bankName: string | null;
  last4: string;
  holderName: string;
  beneficiaryId: string;
  status: BankAccount["status"];
}

export interface NewPendingAction {
  merchantId: MerchantId;
  args: PendingAction["args"]; // kind is taken from args.kind
  confirmMessageIds?: string[];
  expiresAt?: string; // default now + PENDING_ACTION_TTL_MS
}

export interface OnboardingState {
  phone: string;
  channel: Channel;
  step: string; // 'name' | 'category' | 'menu' | 'bank' | 'done'
  data: Record<string, unknown>;
  updatedAt: string;
}

export type ApproveWithdrawalResult =
  | { ok: true; withdrawal: Withdrawal }
  | { ok: false; reason: "not_requested" | "insufficient_funds"; withdrawal: Withdrawal | null };

// ------------------------------------------------------------------ the interface

export interface Db {
  // merchants
  getMerchant(id: MerchantId): Promise<Merchant | null>;
  getMerchantByPhone(phone: string): Promise<Merchant | null>;
  findShop(query: string): Promise<ShopMatch>;
  /** Onboarding creates the draft before the setup card; /internal/merchants later completes the same row. Idempotent. */
  upsertDraftMerchant(m: NewDraftMerchant): Promise<Merchant>;
  updateShop(id: MerchantId, patch: { name?: string; category?: string | null; currency?: Currency }): Promise<Merchant | null>;
  /** Records the custodial XRPL account. The encrypted seed never leaves the DB layer except through getMerchantSeedEnc. */
  setMerchantXrpl(id: MerchantId, a: { xrplAddress: string; xrplSeedEnc: string; credentialStatus: CredentialStatus }): Promise<Merchant | null>;
  getMerchantSeedEnc(xrplAddress: string): Promise<string | null>;
  setMerchantLive(id: MerchantId): Promise<Merchant | null>; // draft → live (CAS)
  setAutoWithdraw(id: MerchantId, mode: AutoWithdraw): Promise<void>;
  listLiveMerchants(): Promise<Merchant[]>;

  // menu
  listMenu(merchantId: MerchantId, opts?: { includeInactive?: boolean }): Promise<MenuItem[]>;
  /** Replace the whole menu (setup card): rows not listed are deleted (invoices keep their own line copies); `active: false` hides. */
  replaceMenu(merchantId: MerchantId, items: MenuItemInput[]): Promise<MenuItem[]>;
  upsertMenuItem(merchantId: MerchantId, item: { name: string; price?: Money; active?: boolean }): Promise<MenuItem>;
  findMenuItems(merchantId: MerchantId, names: string[]): Promise<MenuMatch[]>;

  // contacts
  addContact(merchantId: MerchantId, c: { name: string; phone: string; channel?: Channel | null }): Promise<Contact>; // upsert on (merchant, phone)
  findContacts(merchantId: MerchantId, query?: string): Promise<Contact[]>;
  getContactByName(merchantId: MerchantId, name: string): Promise<{ contact: Contact | null; suggestions: Contact[] }>;

  // invoices (kinds: invoice | one_time_qr | pay_request)
  createInvoice(i: NewInvoice): Promise<Invoice>; // generates id + unique 6-char code
  getInvoice(id: string): Promise<Invoice | null>;
  getInvoiceByCode(code: string): Promise<Invoice | null>; // case-insensitive
  listInvoices(merchantId: MerchantId, status: "open" | "paid" | "all"): Promise<Invoice[]>;
  openInvoicesForPhone(phone: string): Promise<Invoice[]>;
  markInvoicePaid(id: string, paymentId: PaymentId): Promise<boolean>;
  cancelInvoice(merchantId: MerchantId, code: string): Promise<boolean>;
  /** open + past expires_at → expired. Returns what changed. */
  expireInvoices(now?: Date): Promise<Invoice[]>;
  /** Open invoices of kind 'invoice' older than `olderThan` and never reminded. */
  invoicesToRemind(olderThan: Date): Promise<Invoice[]>;
  setInvoiceReminded(id: string): Promise<void>;

  // payments
  insertPayment(p: NewPayment): Promise<Payment>;
  getPayment(id: PaymentId): Promise<Payment | null>;
  getPaymentByStripePI(paymentIntentId: string): Promise<Payment | null>;
  getPaymentByDepositAddress(address: string): Promise<Payment | null>;
  /** CAS on status. Throws `DbConflictError` when the payments_one_per_invoice index rejects a second authorization. */
  transitionPayment(id: PaymentId, from: PaymentStatus[], to: PaymentStatus, patch?: PaymentPatch): Promise<Payment | null>;
  listPaymentsByStatus(statuses: PaymentStatus[], limit?: number): Promise<Payment[]>;
  listPayments(merchantId: MerchantId, limit?: number): Promise<Payment[]>;
  receiptsForPhone(phone: string, limit?: number): Promise<Payment[]>;
  daySummary(merchantId: MerchantId, date: string /* YYYY-MM-DD, Asia/Singapore */): Promise<DaySummary>;
  /**
   * One transaction: CAS settling → settled (+ tx hash, delivered amount), ledger payment_credit (ref = paymentId),
   * invoice paid, payer auto-added as a contact. Null if the payment wasn't `settling`. firstSale = this is the
   * merchant's first payment_credit.
   */
  completeSettlement(paymentId: PaymentId, r: { txHash: string; delivered: string }): Promise<{ payment: Payment; firstSale: boolean } | null>;
  /** Next index for a per-payment BSC deposit address (sequence; never reused). */
  nextDepositIndex(): Promise<number>;

  // ledger
  /** Append-only; unique (kind, ref) makes it idempotent: false if that entry already exists. */
  appendLedger(e: { merchantId: MerchantId; kind: LedgerKind; amount: Money; ref: string }): Promise<boolean>;
  getBalance(merchantId: MerchantId): Promise<Balance>; // merchant_balances view

  // bank accounts (full numbers never reach the DB)
  insertBankAccount(b: NewBankAccount): Promise<BankAccount>; // the merchant's first account becomes default
  listBankAccounts(merchantId: MerchantId): Promise<BankAccount[]>;
  getBankAccount(id: string): Promise<BankAccount | null>;
  getDefaultBankAccount(merchantId: MerchantId): Promise<BankAccount | null>;

  // withdrawals
  insertWithdrawal(w: NewWithdrawal): Promise<Withdrawal>; // status requested
  getWithdrawal(id: WithdrawalId): Promise<Withdrawal | null>;
  transitionWithdrawal(id: WithdrawalId, from: WithdrawalStatus[], to: WithdrawalStatus, patch?: WithdrawalPatch): Promise<Withdrawal | null>;
  /** One transaction: CAS requested → approved (+ action id), re-check available ≥ amount, ledger withdrawal_hold. */
  approveWithdrawal(id: WithdrawalId, actionId: string): Promise<ApproveWithdrawalResult>;
  listWithdrawals(merchantId: MerchantId, limit?: number): Promise<Withdrawal[]>;
  listWithdrawalsByStatus(statuses: WithdrawalStatus[]): Promise<Withdrawal[]>; // boot-time resume
  /** Sum of today's (Asia/Singapore) withdrawals that weren't failed/cancelled, for the daily limit. */
  withdrawnToday(merchantId: MerchantId): Promise<Money>;
  hasCompletedWithdrawal(merchantId: MerchantId): Promise<boolean>; // first-withdrawal step-up rule

  // refunds
  insertRefund(r: { paymentId: PaymentId; merchantId: MerchantId; actionId: string; amount: Money }): Promise<Refund>; // unique action_id
  getRefundByAction(actionId: string): Promise<Refund | null>;
  updateRefund(id: string, patch: { status?: Refund["status"]; stripeRefundId?: string; xrplTxHash?: string; failureReason?: string }): Promise<Refund | null>;
  /** One transaction: refunded_local += amount; status settled → partially_refunded | refunded. */
  addPaymentRefund(paymentId: PaymentId, amount: Money): Promise<Payment | null>;

  // pending actions (agent; only plain code claims them)
  insertAction(a: NewPendingAction): Promise<PendingAction>;
  getAction(id: string): Promise<PendingAction | null>;
  addConfirmMessageIds(id: string, messageIds: string[]): Promise<void>;
  findOpenActionByMessageId(messageId: string): Promise<PendingAction | null>;
  findOpenActionsForMerchant(merchantId: MerchantId): Promise<PendingAction[]>;
  /** proposed → executing, only while unexpired. Null = already claimed, expired or unknown. */
  claimAction(id: string): Promise<PendingAction | null>;
  setActionStatus(id: string, status: PendingActionStatus, result?: unknown): Promise<PendingAction | null>;
  expireActions(now?: Date): Promise<PendingAction[]>;

  // agent memory + onboarding
  appendAgentMessage(m: Omit<AgentMessage, "createdAt">): Promise<void>;
  recentAgentMessages(phone: string, limit: number): Promise<AgentMessage[]>; // oldest first
  getOnboarding(phone: string): Promise<OnboardingState | null>;
  setOnboarding(phone: string, channel: Channel, step: string, data: Record<string, unknown>): Promise<void>;

  // plumbing
  /** Idempotency: true the first time a key is seen (Stripe event ids, Spectrum message ids, envelope ids, BSC logs). */
  claim(key: string): Promise<boolean>;
  insertEvent(envelope: EventEnvelope): Promise<void>;
  markEventDelivered(id: string): Promise<void>;
  /** Events the agent hasn't acknowledged yet, oldest first (boot-time replay). */
  listUndeliveredEvents(limit?: number): Promise<EventEnvelope[]>;

  close(): Promise<void>;
}

/** Unique-constraint conflicts that callers handle (e.g. a second authorization for the same invoice). */
export { DbConflictError } from "./errors";

/**
 * Postgres over `DATABASE_URL` (Supabase transaction pooler in deploys). `max` caps this process's connections
 * (default 5). `close()` ends the pool.
 */
export function createDb(opts: { url?: string; max?: number } = {}): Db {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "@rove/db: DATABASE_URL is not set. Use the Supabase transaction pooler URL (Connect → Transaction pooler, port 6543). " +
        "Tests should use createTestDb() from @rove/db/testing instead.",
    );
  }
  return makeDb(postgresPool(url, { max: opts.max }));
}

let shared: Db | undefined;
/** Process-wide instance from env, for route handlers and services. */
export function getDb(): Db {
  shared ??= createDb();
  return shared;
}
