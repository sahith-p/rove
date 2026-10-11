// Domain types shared by every service. packages/db/schema.sql mirrors these one-to-one
// (snake_case columns ↔ camelCase fields).

import type { Currency, Money } from "./money";

export type MerchantId = string; // slug, e.g. "ahseng"
export type PaymentId = string; // "pay_<hex>"
export type InvoiceId = string; // "inv_<hex>"
export type WithdrawalId = string; // "wd_<hex>"
export type ActionId = string; // "act_<hex>"

export function newId<P extends "pay" | "inv" | "wd" | "act" | "ref" | "evt" | "item" | "ct" | "bank" | "led">(
  prefix: P,
): `${P}_${string}` {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Short human code printed on invoices and QR links, e.g. "K7Q2MX". No 0/O/1/I. */
export function newShortCode(len = 6): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// ------------------------------------------------------------------ people + channels

export type Channel = "imessage" | "whatsapp";

/** Anyone we message. Merchants and customers are both just phone numbers on a channel. */
export interface Recipient {
  /** E.164, e.g. "+6591234567" */
  phone: string;
  channel: Channel;
}

export type Persona = "merchant" | "customer";

// ------------------------------------------------------------------ merchant + shop

export type CredentialStatus = "none" | "issued" | "accepted";
export type AutoWithdraw = "off" | "daily";

export interface Merchant {
  id: MerchantId;
  name: string;
  /** Messaging identity: the agent DMs the merchant here. */
  phone: string;
  channel: Channel;
  category: string | null; // "hawker", "cafe", ...
  country: "SG";
  currency: Currency;
  /** Custodial XRPL account holding the merchant's XSGD balance (keys held by the platform in the demo). */
  xrplAddress: string | null;
  credentialStatus: CredentialStatus;
  autoWithdraw: AutoWithdraw;
  /** "draft" until name + currency are set and the XRPL account exists. */
  status: "draft" | "live";
  createdAt: string;
}

export interface MenuItem {
  id: string;
  merchantId: MerchantId;
  name: string;
  price: Money;
  active: boolean;
  sort: number;
}

/** A merchant's customer contact (added by text, by shared contact card, or automatically after a payment). */
export interface Contact {
  id: string;
  merchantId: MerchantId;
  name: string;
  phone: string;
  channel: Channel | null; // null = unknown, decided at send time
  createdAt: string;
}

// ------------------------------------------------------------------ invoices + QR codes

export interface InvoiceLine {
  menuItemId: string | null;
  name: string;
  qty: number;
  unit: Money;
}

/**
 * kind:
 *  - "invoice":     sent to a specific person by message (has toPhone)
 *  - "one_time_qr": shown as a QR by the merchant; single use, expires when paid
 * A fixed shop QR is not an invoice: it points at /m/<merchantId> and the payer enters an amount or picks menu items.
 */
export type InvoiceKind = "invoice" | "one_time_qr";
export type InvoiceStatus = "open" | "paid" | "expired" | "cancelled";

export interface Invoice {
  id: InvoiceId;
  /** Public short code used in URLs: /pay/<code> */
  code: string;
  merchantId: MerchantId;
  kind: InvoiceKind;
  contactId: string | null;
  to: Recipient | null;
  lines: InvoiceLine[];
  total: Money;
  note: string | null;
  status: InvoiceStatus;
  expiresAt: string;
  paymentId: PaymentId | null;
  createdAt: string;
}

// ------------------------------------------------------------------ payments

/** apple_pay/card = Stripe; bnb = USDT from a BNB Chain wallet (Privy), settled on XRPL like every other payment. */
export type PaymentMethod = "apple_pay" | "card" | "bnb";

export type PaymentSource = "invoice" | "one_time_qr" | "fixed_qr";

/**
 * created → authorized (Stripe succeeded) → settling → settled (XSGD in the merchant's custodial account)
 * settled → partially_refunded | refunded
 * any → failed
 */
export type PaymentStatus =
  | "created"
  | "authorized"
  | "settling"
  | "settled"
  | "partially_refunded"
  | "refunded"
  | "failed";

export interface Quote {
  local: Money; // merchant receives, e.g. S$6.50
  usd: Money; // USD the treasury spends on XRPL
  rate: string; // local per 1 USD
  sendMaxUsd: string; // quote + slippage cap for the path payment
  expiresAt: string;
}

export interface Payment {
  id: PaymentId;
  merchantId: MerchantId;
  source: PaymentSource;
  invoiceId: InvoiceId | null;
  lines: InvoiceLine[]; // copied from the invoice or picked on the fixed-QR page; [] for a free amount
  local: Money;
  quote: Quote | null;
  method: PaymentMethod;
  status: PaymentStatus;
  /** Optional: payer's phone (from the invoice, or typed on the pay page for a receipt). */
  payer: Recipient | null;
  stripePaymentIntentId?: string;
  settleTxHash?: string;
  deliveredAmount?: string;
  refunded: Money;
  createdAt: string;
  updatedAt: string;
}

export interface Refund {
  id: string;
  paymentId: PaymentId;
  merchantId: MerchantId;
  actionId: ActionId;
  amount: Money;
  status: "pending" | "completed" | "failed";
  stripeRefundId?: string;
  xrplTxHash?: string;
  createdAt: string;
}

// ------------------------------------------------------------------ balance + withdrawals

/** Merchant money is tracked twice: the XSGD balance on their custodial XRPL account (funds)
 *  and an append-only ledger in Postgres (holds + history). They must reconcile. */
export type LedgerKind =
  | "payment_credit" // +, a sale settled
  | "refund_debit" // −, a refund
  | "withdrawal_hold" // −available, +held, when a withdrawal is approved
  | "withdrawal_release" // +available, −held, when a withdrawal fails/cancels
  | "withdrawal_debit" // −held, when the withdrawal leaves the account
  | "withdrawal_return"; // +available, when the payout partner bounces a withdrawal and the XSGD comes back

export interface LedgerEntry {
  id: string;
  merchantId: MerchantId;
  kind: LedgerKind;
  amount: Money; // always positive; kind gives the sign
  ref: string; // paymentId / refundId / withdrawalId
  createdAt: string;
}

export interface Balance {
  available: Money;
  held: Money; // in-flight withdrawals
  total: Money;
}

export type BankAccountType = "paynow_uen" | "paynow_mobile" | "bank_account";

/** Bank details are entered only on the secure web form, never in chat. We store a partner beneficiary id + last 4. */
export interface BankAccount {
  id: string;
  merchantId: MerchantId;
  type: BankAccountType;
  bankName: string | null; // "DBS/POSB", null for PayNow
  last4: string;
  holderName: string; // as returned by the partner's name check
  beneficiaryId: string; // partner-side id (StraitsX in production; mock in the demo)
  status: "verified" | "pending" | "failed";
  isDefault: boolean;
  createdAt: string;
}

export type WithdrawalDestination =
  | { kind: "bank"; bankAccountId: string }
  | { kind: "xrpl_wallet"; address: string }; // self-custody: XSGD to the merchant's own XRPL wallet (real on testnet)

/**
 * requested (agent proposed) → approved (human confirmed; funds held)
 *   → onchain_pending → onchain_settled (XSGD at the redemption address, or at the merchant's wallet)
 *   → payout_pending (partner payout created) → completed (bank reference)
 * failure paths: failed (before funds left; hold released) · returned (partner bounced; funds re-credited)
 * xrpl_wallet withdrawals complete at onchain_settled.
 */
export type WithdrawalStatus =
  | "requested"
  | "approved"
  | "onchain_pending"
  | "onchain_settled"
  | "payout_pending"
  | "completed"
  | "failed"
  | "returned"
  | "cancelled";

export interface Withdrawal {
  id: WithdrawalId;
  merchantId: MerchantId;
  amount: Money;
  fee: Money;
  destination: WithdrawalDestination;
  status: WithdrawalStatus;
  sweepTxHash?: string;
  partnerPayoutId?: string;
  bankRef?: string; // e.g. "FAST-881245"
  failureReason?: string;
  /** Becomes true for first-time or large withdrawals: must also confirm on the web page. */
  needsStepUp: boolean;
  createdAt: string;
  updatedAt: string;
}

export const WITHDRAWAL_LIMITS = { minSgd: "1.00", stepUpAboveSgd: "200.00", dailyMaxSgd: "2000.00" } as const;

// ------------------------------------------------------------------ confirmations

export type PendingActionKind = "refund" | "withdrawal" | "set_auto_withdraw";
export type PendingActionStatus = "proposed" | "executing" | "done" | "expired" | "failed" | "cancelled";

export type PendingActionArgs =
  | { kind: "refund"; paymentId: PaymentId; amount: Money; reason: string }
  | { kind: "withdrawal"; withdrawalId: WithdrawalId }
  | { kind: "set_auto_withdraw"; mode: AutoWithdraw };

export interface PendingAction {
  id: ActionId;
  merchantId: MerchantId;
  kind: PendingActionKind;
  args: PendingActionArgs;
  status: PendingActionStatus;
  /** Message ids a 👍 tapback (iMessage) can target; WhatsApp confirms by replying YES. */
  confirmMessageIds: string[];
  expiresAt: string;
  createdAt: string;
  result?: unknown;
}

export const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------ reporting + agent memory

export interface DaySummary {
  merchantId: MerchantId;
  date: string; // YYYY-MM-DD Asia/Singapore
  count: number;
  gross: Money;
  refunded: Money;
  net: Money;
  openInvoices: number;
}

export interface AgentMessage {
  phone: string;
  persona: Persona;
  merchantId: MerchantId | null; // the shop this thread is about (customer threads can span shops)
  role: "user" | "assistant";
  content: string; // plain text only, append-only
  channel: Channel;
  createdAt: string;
}
