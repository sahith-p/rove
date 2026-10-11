// HTTP contracts. Every route validates with these schemas.
// Public + merchant routes: apps/web/app/api. Internal routes: worker and agent services,
// `authorization: Bearer ${INTERNAL_SECRET}`. Merchant routes: `x-rove-session: <MerchantSessionToken>`.

import { z } from "zod";

export const Decimal = z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal string");
export const CurrencyZ = z.enum(["SGD", "USD"]);
export const MoneyZ = z.object({ amount: Decimal, currency: CurrencyZ });
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone");
export const ChannelZ = z.enum(["imessage", "whatsapp"]);
export const RecipientZ = z.object({ phone: E164, channel: ChannelZ });
export const AutoWithdrawZ = z.enum(["off", "daily"]);
export const PaymentStatusZ = z.enum(["created", "authorized", "settling", "settled", "partially_refunded", "refunded", "failed"]);
export const WithdrawalStatusZ = z.enum([
  "requested",
  "approved",
  "onchain_pending",
  "onchain_settled",
  "payout_pending",
  "completed",
  "failed",
  "returned",
  "cancelled",
]);
export const QuoteZ = z.object({ local: MoneyZ, usd: MoneyZ, rate: Decimal, sendMaxUsd: Decimal, expiresAt: z.string() });
export const InvoiceLineZ = z.object({ menuItemId: z.string().nullable(), name: z.string(), qty: z.number().int().positive(), unit: MoneyZ });
export const MenuItemViewZ = z.object({ id: z.string(), name: z.string(), price: MoneyZ, active: z.boolean() });
export const WithdrawalDestinationZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bank"), bankAccountId: z.string() }),
  z.object({ kind: z.literal("xrpl_wallet"), address: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/) }),
]);
export const BankAccountViewZ = z.object({
  id: z.string(),
  type: z.enum(["paynow_uen", "paynow_mobile", "bank_account"]),
  bankName: z.string().nullable(),
  last4: z.string(),
  holderName: z.string(),
  status: z.enum(["verified", "pending", "failed"]),
  isDefault: z.boolean(),
});
export const WithdrawalViewZ = z.object({
  id: z.string(),
  amount: MoneyZ,
  fee: MoneyZ,
  destination: z.object({ kind: z.enum(["bank", "xrpl_wallet"]), label: z.string() }), // "DBS ••••1234" / "rP4x…9Kd"
  status: WithdrawalStatusZ,
  sweepTxHash: z.string().optional(),
  bankRef: z.string().optional(),
  failureReason: z.string().optional(),
  needsStepUp: z.boolean(),
  explorerUrl: z.string().url().optional(),
  updatedAt: z.string(),
});
export const PendingActionViewZ = z.object({
  id: z.string(),
  kind: z.enum(["refund", "withdrawal", "set_auto_withdraw"]),
  summary: z.string(), // "Withdraw S$50.00 to DBS ••••1234"
  status: z.enum(["proposed", "executing", "done", "expired", "failed", "cancelled"]),
  expiresAt: z.string(),
});

// ---------------------------------------------------------------- public (customers)  [owner: Nithya]

/** GET /api/shops/:merchantId  Fixed-QR page header + menu. */
export const ShopPublicRes = z.object({
  id: z.string(),
  name: z.string(),
  currency: CurrencyZ,
  verified: z.boolean(), // XRPL Credential ROVE_VERIFIED_MERCHANT accepted
  menu: z.array(MenuItemViewZ),
});

/** GET /api/invoices/:code  Invoice / one-time QR pay page. */
export const InvoicePublicRes = z.object({
  code: z.string(),
  kind: z.enum(["invoice", "one_time_qr", "pay_request"]),
  merchant: z.object({ id: z.string(), name: z.string(), verified: z.boolean() }),
  lines: z.array(InvoiceLineZ),
  total: MoneyZ,
  note: z.string().nullable(),
  status: z.enum(["open", "paid", "expired", "cancelled"]),
  expiresAt: z.string(),
});

/** POST /api/checkout  Starts a payment for an invoice code, or a fixed-QR payment (amount or menu items). */
export const CheckoutReq = z.object({
  target: z.discriminatedUnion("source", [
    z.object({ source: z.literal("invoice"), code: z.string() }),
    z.object({
      source: z.literal("fixed_qr"),
      merchantId: z.string(),
      amount: Decimal.optional(),
      items: z.array(z.object({ menuItemId: z.string(), qty: z.number().int().positive() })).optional(),
    }),
  ]),
  method: z.enum(["card", "bnb"]),
  /** optional "text me the receipt" */
  payerPhone: E164.optional(),
});
export const CheckoutRes = z.object({
  paymentId: z.string(),
  local: MoneyZ,
  quote: QuoteZ,
  /** method=card: Stripe Express Checkout (Apple Pay / Google Pay / card) */
  stripe: z.object({ clientSecret: z.string() }).optional(),
  /** method=bnb: send test USDT on BSC testnet to this per-payment deposit address (Privy wallet) */
  bnb: z.object({ chainId: z.literal(97), depositAddress: z.string(), token: z.string(), decimals: z.number(), amount: Decimal }).optional(),
});

/** GET /api/payments/:paymentId  Polled by the pay page and receipt page. */
export const PaymentStatusRes = z.object({
  paymentId: z.string(),
  status: PaymentStatusZ,
  local: MoneyZ,
  merchantName: z.string(),
  lines: z.array(InvoiceLineZ),
  method: z.enum(["apple_pay", "card", "bnb"]),
  settleTxHash: z.string().optional(),
  explorerUrl: z.string().url().optional(),
});

/** POST /api/stripe/webhook  raw body, Stripe signature. */

// ---------------------------------------------------------------- merchant web (x-rove-session)  [owner: Nithya unless noted]

/** GET /api/me  Everything the minimal "my shop" page shows. */
export const MeRes = z.object({
  merchant: z.object({
    id: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    currency: CurrencyZ,
    status: z.enum(["draft", "live"]),
    autoWithdraw: AutoWithdrawZ,
    verified: z.boolean(),
  }),
  balance: z.object({ available: MoneyZ, held: MoneyZ, total: MoneyZ }),
  menu: z.array(MenuItemViewZ),
  contacts: z.array(z.object({ id: z.string(), name: z.string(), phone: z.string() })),
  openInvoices: z.array(z.object({ code: z.string(), to: z.string().nullable(), total: MoneyZ, createdAt: z.string() })),
  recentPayments: z.array(
    z.object({ id: z.string(), local: MoneyZ, status: PaymentStatusZ, source: z.enum(["invoice", "one_time_qr", "fixed_qr", "pay_request"]), createdAt: z.string() }),
  ),
  bankAccounts: z.array(BankAccountViewZ),
  withdrawals: z.array(WithdrawalViewZ),
});

/** PUT /api/me/shop  From the setup card. Emits shop.updated. */
export const UpdateShopReq = z.object({
  name: z.string().min(2).max(60).optional(),
  category: z.string().max(40).optional(),
  currency: z.literal("SGD").optional(),
});

/** PUT /api/me/menu  Replace the menu (setup card). Emits shop.updated. */
export const UpdateMenuReq = z.object({
  items: z
    .array(z.object({ id: z.string().optional(), name: z.string().min(1).max(60), price: Decimal, active: z.boolean().default(true) }))
    .max(50),
});

/** POST /api/me/bank-accounts  The secure bank form. Raw numbers go to the payout partner, never stored in full. Emits bank_account.added. */
export const AddBankAccountReq = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paynow_uen"), uen: z.string().regex(/^[0-9A-Z]{9,10}$/), holderName: z.string().min(2) }),
  z.object({ type: z.literal("paynow_mobile"), mobile: E164, holderName: z.string().min(2) }),
  z.object({ type: z.literal("bank_account"), bankName: z.string(), accountNumber: z.string().regex(/^\d{6,16}$/), holderName: z.string().min(2) }),
]);
export const AddBankAccountRes = BankAccountViewZ;

/** GET /api/withdrawals/:id  Withdrawal card + page. */
export const WithdrawalRes = WithdrawalViewZ;

/** POST /api/actions/:actionId/confirm  [owner: Saran]  Confirm buttons (confirm card, withdrawal step-up page). Proxies to the agent. */
export const ConfirmActionReq = z.object({ token: z.string() });
export const ConfirmActionRes = z.object({ action: PendingActionViewZ });

// ---------------------------------------------------------------- internal: worker [owner: Nithya]

/** POST {WORKER_URL}/internal/settle  Idempotent on paymentId. */
export const InternalSettleReq = z.object({ paymentId: z.string() });

/** POST {WORKER_URL}/internal/refunds  Idempotent on actionId. */
export const InternalRefundReq = z.object({ actionId: z.string(), paymentId: z.string(), amount: Decimal });
export const InternalRefundRes = z.object({ refundId: z.string(), status: z.enum(["pending", "completed", "failed"]) });

/** POST {WORKER_URL}/internal/withdrawals  Agent's propose tool: validates + creates a `requested` withdrawal. No money moves. */
export const InternalCreateWithdrawalReq = z.object({
  merchantId: z.string(),
  amount: Decimal.nullable(), // null = everything available
  destination: WithdrawalDestinationZ.nullable(), // null = default bank account
});
export const InternalCreateWithdrawalRes = WithdrawalViewZ;

/** POST {WORKER_URL}/internal/withdrawals/:id/execute  Called only after a human confirmed. Idempotent on withdrawal id. */
export const InternalExecuteWithdrawalReq = z.object({ actionId: z.string() });

/** POST {WORKER_URL}/internal/merchants  Onboarding: custodial XRPL account, trust lines, Credential → status live. */
export const InternalCreateMerchantReq = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,32}$/),
  name: z.string().min(2).max(60),
  phone: E164,
  channel: ChannelZ,
  currency: z.literal("SGD"),
  category: z.string().nullable(),
});
export const InternalCreateMerchantRes = z.object({
  merchantId: z.string(),
  xrplAddress: z.string(),
  credentialStatus: z.enum(["issued", "accepted"]),
});

/** PATCH {WORKER_URL}/internal/merchants/:id/auto-withdraw */
export const InternalSetAutoWithdrawReq = z.object({ mode: AutoWithdrawZ });

// ---------------------------------------------------------------- internal: agent [owner: Saran]

/** POST {AGENT_URL}/internal/events  Body: EventEnvelope (events.ts). Idempotent on envelope id. */

/** POST {AGENT_URL}/internal/actions/:actionId/confirm */
export const InternalConfirmReq = z.object({ via: z.enum(["tapback", "reply", "card", "web"]) });
export const InternalConfirmRes = ConfirmActionRes;

// ---------------------------------------------------------------- route constants

export const ROUTES = {
  shop: (merchantId: string) => `/api/shops/${merchantId}`,
  invoice: (code: string) => `/api/invoices/${code}`,
  checkout: "/api/checkout",
  payment: (paymentId: string) => `/api/payments/${paymentId}`,
  stripeWebhook: "/api/stripe/webhook",
  me: "/api/me",
  meShop: "/api/me/shop",
  meMenu: "/api/me/menu",
  meBankAccounts: "/api/me/bank-accounts",
  withdrawal: (id: string) => `/api/withdrawals/${id}`,
  confirmAction: (actionId: string) => `/api/actions/${actionId}/confirm`,
  worker: {
    settle: "/internal/settle",
    refunds: "/internal/refunds",
    withdrawals: "/internal/withdrawals",
    executeWithdrawal: (id: string) => `/internal/withdrawals/${id}/execute`,
    merchants: "/internal/merchants",
    autoWithdraw: (merchantId: string) => `/internal/merchants/${merchantId}/auto-withdraw`,
  },
  agent: {
    events: "/internal/events",
    confirm: (actionId: string) => `/internal/actions/${actionId}/confirm`,
  },
} as const;

export const SESSION_HEADER = "x-rove-session";

export function internalHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

export function isInternalAuthorized(header: string | null | undefined, secret: string): boolean {
  return header === `Bearer ${secret}`;
}
