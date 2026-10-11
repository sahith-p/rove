// Row (snake_case) ↔ domain (camelCase) mapping. The only place column names meet domain field names.
// Numerics arrive as strings and leave as Money / decimal strings; timestamps leave as ISO strings.

import {
  DECIMALS,
  fromMinor,
  money,
  toUnits,
  type AgentMessage,
  type AutoWithdraw,
  type BankAccount,
  type Channel,
  type Contact,
  type CredentialStatus,
  type Currency,
  type EventEnvelope,
  type Invoice,
  type InvoiceLine,
  type MenuItem,
  type Merchant,
  type Money,
  type Payment,
  type PendingAction,
  type Quote,
  type Recipient,
  type Refund,
  type Withdrawal,
} from "@rove/shared";
import type { Row } from "./executor";
import type { OnboardingState } from "./index";

// ------------------------------------------------------------------ column lists (never select the encrypted seed by accident)

export const MERCHANT_COLS =
  "id, name, phone, channel, category, country, currency, xrpl_address, credential_status, auto_withdraw, status, created_at";
export const MENU_COLS = "id, merchant_id, name, price, currency, active, sort";
export const CONTACT_COLS = "id, merchant_id, name, phone, channel, created_at";
export const INVOICE_COLS =
  "id, code, merchant_id, kind, contact_id, to_phone, to_channel, lines, total, currency, note, status, expires_at, payment_id, created_at";
export const PAYMENT_COLS =
  "id, merchant_id, source, invoice_id, lines, amount_local, currency, quote_usd, quote_rate, quote_send_max_usd, quote_expires_at, " +
  "charge_amount, charge_currency, method, status, payer_phone, payer_channel, stripe_payment_intent, settle_tx_hash, delivered_amount, " +
  "refunded_local, created_at, updated_at, quote_from, quote_pay, quote_send_max";
export const REFUND_COLS = "id, payment_id, merchant_id, action_id, amount_local, currency, status, stripe_refund_id, xrpl_tx_hash, created_at";
export const BANK_COLS = "id, merchant_id, type, bank_name, last4, holder_name, beneficiary_id, status, is_default, created_at";
export const WITHDRAWAL_COLS =
  "id, merchant_id, amount_local, fee_local, currency, destination_kind, bank_account_id, wallet_address, status, needs_step_up, " +
  "sweep_tx_hash, partner_payout_id, bank_ref, failure_reason, created_at, updated_at";
export const ACTION_COLS =
  "id, merchant_id, kind, args, status, to_jsonb(confirm_message_ids) as confirm_message_ids, expires_at, result, created_at";

// ------------------------------------------------------------------ scalars

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw new Error(`@rove/db: not a timestamp: ${String(v)}`);
}

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** A numeric column → Money at the currency's decimals (exact; extra trailing zeros from numeric(18,6) are fine). */
export function dbMoney(v: unknown, currency: Currency): Money {
  const s = String(v).trim();
  const neg = s.startsWith("-");
  const units = toUnits(neg ? s.slice(1) : s, DECIMALS[currency], "exact");
  return fromMinor(neg ? -units : units, currency);
}

/** "1.28600000" → "1.286", "12.500000" → "12.50": numeric scale padding removed, at least `minDecimals` kept. */
export function trimDecimal(v: unknown, minDecimals = 2): string {
  const s = String(v);
  const dot = s.indexOf(".");
  if (dot < 0) return minDecimals > 0 ? `${s}.${"0".repeat(minDecimals)}` : s;
  let end = s.length;
  while (end > dot + 1 + minDecimals && s[end - 1] === "0") end--;
  const out = s.slice(0, end);
  return out.endsWith(".") ? out.slice(0, -1) : out.padEnd(dot + 1 + minDecimals, "0");
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
/** Validates a decimal string before it reaches a numeric column (no floats, no exponents, no signs). */
export function decimal(v: string): string {
  const s = v.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`@rove/db: invalid decimal: ${v}`);
  return s;
}

/** Normalizes Money to the currency's decimals (throws on more precision than the currency has). */
export function norm(m: Money): Money {
  return money(m.amount, m.currency);
}

/** Strips formatting from a phone number, keeping a leading "+": "+65 9123-4567" → "+6591234567". No country guessing. */
export function normalizePhone(p: string): string {
  const t = p.trim();
  const digits = t.replace(/\D/g, "");
  if (!digits) return t;
  return t.startsWith("+") || t.startsWith("00") ? `+${t.startsWith("00") ? digits.slice(2) : digits}` : digits;
}

export function phoneDigits(p: string): string {
  return p.replace(/\D/g, "");
}

function recipient(phone: unknown, channel: unknown): Recipient | null {
  return phone != null && channel != null ? { phone: str(phone), channel: channel as Channel } : null;
}

function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

// ------------------------------------------------------------------ lines

export function linesFromDb(v: unknown): InvoiceLine[] {
  const raw = json<Array<Partial<InvoiceLine>> | null>(v) ?? [];
  return raw.map((l) => ({
    menuItemId: l.menuItemId ?? null,
    name: String(l.name ?? ""),
    qty: Number(l.qty),
    unit: norm(l.unit as Money),
  }));
}

/** Validates + normalizes lines for a jsonb column. */
export function linesToDb(lines: readonly InvoiceLine[]): string {
  return JSON.stringify(
    lines.map((l) => {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error(`@rove/db: line "${l.name}" has invalid qty ${l.qty}`);
      return { menuItemId: l.menuItemId ?? null, name: l.name, qty: l.qty, unit: norm(l.unit) };
    }),
  );
}

// ------------------------------------------------------------------ rows → domain

export function toMerchant(r: Row): Merchant {
  return {
    id: str(r.id),
    name: str(r.name),
    phone: str(r.phone),
    channel: r.channel as Channel,
    category: strOrNull(r.category),
    country: str(r.country),
    currency: r.currency as Currency,
    xrplAddress: strOrNull(r.xrpl_address),
    credentialStatus: r.credential_status as CredentialStatus,
    autoWithdraw: r.auto_withdraw as AutoWithdraw,
    status: r.status as Merchant["status"],
    createdAt: iso(r.created_at),
  };
}

export function toMenuItem(r: Row): MenuItem {
  return {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    name: str(r.name),
    price: dbMoney(r.price, r.currency as Currency),
    active: Boolean(r.active),
    sort: Number(r.sort),
  };
}

export function toContact(r: Row): Contact {
  return {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    name: str(r.name),
    phone: str(r.phone),
    channel: (r.channel as Channel | null) ?? null,
    createdAt: iso(r.created_at),
  };
}

export function toInvoice(r: Row): Invoice {
  return {
    id: str(r.id),
    code: str(r.code),
    merchantId: str(r.merchant_id),
    kind: r.kind as Invoice["kind"],
    contactId: strOrNull(r.contact_id),
    to: recipient(r.to_phone, r.to_channel),
    lines: linesFromDb(r.lines),
    total: dbMoney(r.total, r.currency as Currency),
    note: strOrNull(r.note),
    status: r.status as Invoice["status"],
    expiresAt: iso(r.expires_at),
    paymentId: strOrNull(r.payment_id),
    createdAt: iso(r.created_at),
  };
}

/** The stored quote, with the payer-currency route (pay + sendMax in quote_from) when it was recorded. */
function quoteFromRow(r: Row, local: Money): Quote | null {
  const hasQuote = r.quote_usd != null && r.quote_rate != null && r.quote_send_max_usd != null && r.quote_expires_at != null;
  if (!hasQuote) return null;
  const q: Quote = {
    local,
    usd: dbMoney(r.quote_usd, "USD"),
    rate: trimDecimal(r.quote_rate),
    sendMaxUsd: trimDecimal(r.quote_send_max_usd),
    expiresAt: iso(r.quote_expires_at),
  };
  if (r.quote_from != null && r.quote_pay != null && r.quote_send_max != null) {
    const from = r.quote_from as Currency;
    q.pay = dbMoney(r.quote_pay, from);
    q.sendMax = trimDecimal(r.quote_send_max, DECIMALS[from]);
  }
  return q;
}

export function toPayment(r: Row): Payment {
  const currency = r.currency as Currency;
  const local = dbMoney(r.amount_local, currency);
  const p: Payment = {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    source: r.source as Payment["source"],
    invoiceId: strOrNull(r.invoice_id),
    lines: linesFromDb(r.lines),
    local,
    quote: quoteFromRow(r, local),
    method: r.method as Payment["method"],
    status: r.status as Payment["status"],
    payer: recipient(r.payer_phone, r.payer_channel),
    refunded: dbMoney(r.refunded_local, currency),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
  if (r.charge_amount != null && r.charge_currency != null) p.charge = dbMoney(r.charge_amount, r.charge_currency as Currency);
  if (r.stripe_payment_intent != null) p.stripePaymentIntentId = str(r.stripe_payment_intent);
  if (r.settle_tx_hash != null) p.settleTxHash = str(r.settle_tx_hash);
  if (r.delivered_amount != null) p.deliveredAmount = trimDecimal(r.delivered_amount);
  return p;
}

export function toRefund(r: Row): Refund {
  const out: Refund = {
    id: str(r.id),
    paymentId: str(r.payment_id),
    merchantId: str(r.merchant_id),
    actionId: str(r.action_id),
    amount: dbMoney(r.amount_local, r.currency as Currency),
    status: r.status as Refund["status"],
    createdAt: iso(r.created_at),
  };
  if (r.stripe_refund_id != null) out.stripeRefundId = str(r.stripe_refund_id);
  if (r.xrpl_tx_hash != null) out.xrplTxHash = str(r.xrpl_tx_hash);
  return out;
}

export function toBankAccount(r: Row): BankAccount {
  return {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    type: r.type as BankAccount["type"],
    bankName: strOrNull(r.bank_name),
    last4: str(r.last4),
    holderName: str(r.holder_name),
    beneficiaryId: str(r.beneficiary_id),
    status: r.status as BankAccount["status"],
    isDefault: Boolean(r.is_default),
    createdAt: iso(r.created_at),
  };
}

export function toWithdrawal(r: Row): Withdrawal {
  const currency = r.currency as Currency;
  const w: Withdrawal = {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    amount: dbMoney(r.amount_local, currency),
    fee: dbMoney(r.fee_local, currency),
    destination:
      r.destination_kind === "bank"
        ? { kind: "bank", bankAccountId: str(r.bank_account_id) }
        : { kind: "xrpl_wallet", address: str(r.wallet_address) },
    status: r.status as Withdrawal["status"],
    needsStepUp: Boolean(r.needs_step_up),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
  if (r.sweep_tx_hash != null) w.sweepTxHash = str(r.sweep_tx_hash);
  if (r.partner_payout_id != null) w.partnerPayoutId = str(r.partner_payout_id);
  if (r.bank_ref != null) w.bankRef = str(r.bank_ref);
  if (r.failure_reason != null) w.failureReason = str(r.failure_reason);
  return w;
}

export function toAction(r: Row): PendingAction {
  const a: PendingAction = {
    id: str(r.id),
    merchantId: str(r.merchant_id),
    kind: r.kind as PendingAction["kind"],
    args: json<PendingAction["args"]>(r.args),
    status: r.status as PendingAction["status"],
    confirmMessageIds: (json<string[] | null>(r.confirm_message_ids) ?? []).map(String),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
  };
  if (r.result != null) a.result = json<unknown>(r.result);
  return a;
}

export function toAgentMessage(r: Row): AgentMessage {
  return {
    phone: str(r.phone),
    persona: r.persona as AgentMessage["persona"],
    merchantId: strOrNull(r.merchant_id),
    role: r.role as AgentMessage["role"],
    content: str(r.content),
    channel: r.channel as Channel,
    createdAt: iso(r.created_at),
  };
}

export function toOnboarding(r: Row): OnboardingState {
  return {
    phone: str(r.phone),
    channel: r.channel as Channel,
    step: str(r.step),
    data: json<Record<string, unknown>>(r.data) ?? {},
    updatedAt: iso(r.updated_at),
  };
}

export function toEnvelope(r: Row): EventEnvelope {
  return { id: str(r.id), at: iso(r.at), event: json<EventEnvelope["event"]>(r.payload) };
}
