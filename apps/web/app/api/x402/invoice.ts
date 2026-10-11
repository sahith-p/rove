// x402: an AI agent pays a Rove invoice in AUSD over HTTP 402. Owner: Nithya · Spec: docs/specs/ausd-lane.md §x402.
// Self-facilitated: Rove verifies the payment here and its own worker relayer settles it on Base Sepolia (no third party).
//
//   GET /api/x402/invoices/:code                         → 402 PaymentRequired (body + PAYMENT-REQUIRED header)
//   GET /api/x402/invoices/:code + PAYMENT-SIGNATURE     → verify → ausd payment + stored authorization → wait for the
//                                                          relayer (≤ 30s) → 200 receipt + PAYMENT-RESPONSE
//
// The price is the open invoice's total quoted in USD at 402 time (1 AUSD = 1 USD). The quote travels inside the
// requirements as a signed token (accepted.extra.roveQuote, HMAC with TOKEN_SECRET) that the client echoes back in
// `accepted`, so we charge exactly what we offered without storing anything for a 402 nobody pays.
// Resending the same PAYMENT-SIGNATURE is idempotent (same payment, same receipt): that's also how a client polls after a 202.

import { getAddress, type Address, type Hex } from "viem";
import { DbConflictError } from "@rove/db";
import {
  cmp,
  format,
  links,
  newId,
  signToken,
  verifyToken,
  type Invoice,
  type Merchant,
  type Money,
  type Payment,
  type Quote,
} from "@rove/shared";
import {
  ausdCharge,
  basescanTxUrl,
  invoicePaidElsewhere,
  toStoredAuthorization,
  usdToAusdUnits,
  verifyAusdAuthorization,
  type AusdDeps,
  type AusdRejection,
  type TransferWithAuthorization,
} from "../_lib/ausd";
import type { WebDeps } from "../_lib/deps";
import { errorJson, json } from "../_lib/http";
import {
  encodeHeader,
  readPaymentHeader,
  X402_HEADERS,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
  type X402ErrorReason,
} from "./protocol";

/** Time the agent gets to sign after the 402 (and the authorization window it should use). */
export const X402_MAX_TIMEOUT_SECONDS = 600;

export interface X402Options {
  /** How long to wait for the relayer before answering 202 (default 30s). */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface QuoteToken {
  kind: "x402_quote";
  invoiceId: string;
  local: Money;
  usd: Money;
  rate: string;
  sendMaxUsd: string;
  quoteExpiresAt: string;
  exp: number;
}

const PAID_OR_LATER: ReadonlySet<Payment["status"]> = new Set(["authorized", "settling", "settled", "partially_refunded", "refunded"]);

function tokenSecret(): string {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET is not set");
  return secret;
}

function resourceUrl(req: Request): string {
  const u = new URL(req.url);
  return `${u.origin}${u.pathname}`;
}

function payable(invoice: Invoice, now: number): boolean {
  return invoice.status === "open" && Date.parse(invoice.expiresAt) > now;
}

function notOpen(invoice: Invoice, now: number): Response {
  const status = invoice.status === "open" && Date.parse(invoice.expiresAt) <= now ? "expired" : invoice.status;
  const message = status === "paid" ? "This invoice has already been paid." : status === "cancelled" ? "The shop cancelled this invoice." : "This invoice has expired.";
  return errorJson(410, `invoice_${status}`, message);
}

/** Fresh quote → the PaymentRequirements we accept for this invoice. */
async function requirementsFor(deps: WebDeps, ausd: AusdDeps, invoice: Invoice, now: number): Promise<PaymentRequirements> {
  const quote = await deps.settlement.quote({ local: invoice.total });
  const usd = ausdCharge(quote);
  const quoteExpSec = Math.floor(Date.parse(quote.expiresAt) / 1000);
  const token: QuoteToken = {
    kind: "x402_quote",
    invoiceId: invoice.id,
    local: invoice.total,
    usd,
    rate: quote.rate,
    sendMaxUsd: quote.sendMaxUsd,
    quoteExpiresAt: quote.expiresAt,
    // The offer stays good as long as an authorization signed right before the quote expired could still be relayed.
    exp: Math.max(quoteExpSec, Math.floor(now / 1000)) + X402_MAX_TIMEOUT_SECONDS,
  };
  return {
    scheme: "exact",
    network: ausd.config.network,
    amount: usdToAusdUnits(usd, ausd.config.decimals).toString(),
    asset: ausd.config.token,
    payTo: ausd.config.payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: {
      assetTransferMethod: "eip3009",
      name: ausd.config.eip712Name,
      version: ausd.config.eip712Version,
      roveQuote: signToken(token, tokenSecret()),
      usd: usd.amount,
      local: format(invoice.total),
    },
  };
}

async function paymentRequired(
  req: Request,
  deps: WebDeps,
  ausd: AusdDeps,
  invoice: Invoice,
  merchant: Merchant,
  now: number,
  error: string,
  failure?: SettlementResponse,
): Promise<Response> {
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource: { url: resourceUrl(req), description: `${merchant.name} · ${format(invoice.total)}`, mimeType: "application/json" },
    accepts: [await requirementsFor(deps, ausd, invoice, now)],
  };
  const headers = new Headers({ [X402_HEADERS.required]: encodeHeader(body) });
  if (failure) {
    headers.set(X402_HEADERS.response, encodeHeader(failure));
    headers.set(X402_HEADERS.legacyResponse, encodeHeader(failure));
  }
  return json(body, { status: 402, headers });
}

function failure(ausd: AusdDeps, reason: X402ErrorReason, payer?: string, transaction = ""): SettlementResponse {
  return { success: false, errorReason: reason, transaction, network: ausd.config.network, ...(payer ? { payer } : {}) };
}

const REJECTION_REASON: Record<Exclude<AusdRejection, "chain_unavailable">, X402ErrorReason> = {
  invalid_signature: "invalid_exact_evm_payload_signature",
  authorization_not_yet_valid: "invalid_exact_evm_payload_authorization_valid_after",
  authorization_expired: "invalid_exact_evm_payload_authorization_valid_before",
  authorization_used: "invalid_exact_evm_payload_authorization_nonce_used",
  insufficient_funds: "insufficient_funds",
};

/** The signed quote from accepted.extra.roveQuote, if it's ours, for this invoice, unexpired. */
function quoteFrom(accepted: PaymentRequirements, invoice: Invoice, nowSec: number): Quote | null {
  const raw = accepted.extra?.roveQuote;
  if (typeof raw !== "string") return null;
  let t: QuoteToken | null;
  try {
    t = verifyToken<QuoteToken>(raw, tokenSecret(), nowSec);
  } catch {
    return null;
  }
  if (!t || t.kind !== "x402_quote" || t.invoiceId !== invoice.id) return null;
  if (t.local.currency !== invoice.total.currency || cmp(t.local, invoice.total) !== 0) return null;
  return { local: t.local, usd: t.usd, rate: t.rate, sendMaxUsd: t.sendMaxUsd, expiresAt: t.quoteExpiresAt };
}

export async function handleX402Invoice(req: Request, rawCode: string, deps: WebDeps, ausd: AusdDeps, opts: X402Options = {}): Promise<Response> {
  const now = opts.now?.() ?? Date.now();
  const code = rawCode.trim();
  const invoice = code && code.length <= 32 ? await deps.db.getInvoiceByCode(code) : null;
  if (!invoice) return errorJson(404, "invoice_not_found", "This invoice doesn't exist.");
  const merchant = await deps.db.getMerchant(invoice.merchantId);
  if (!merchant) return errorJson(404, "invoice_not_found", "This invoice doesn't exist.");

  const decoded = readPaymentHeader(req);
  if (decoded === null) {
    if (!payable(invoice, now)) return notOpen(invoice, now);
    return paymentRequired(req, deps, ausd, invoice, merchant, now, "PAYMENT-SIGNATURE header is required");
  }
  if (!decoded.ok) return errorJson(400, "invalid_payment", decoded.message);
  const { accepted, payload } = decoded.payment;
  const a = payload.authorization;
  const from = getAddress(a.from);

  // Same authorization again: the client is retrying or polling. Answer from the payment it already made.
  const existing = await deps.db.getPaymentByAusdNonce(from, a.nonce);
  if (existing) {
    if (existing.invoiceId !== invoice.id) return errorJson(409, "authorization_reused", "This authorization already paid for something else.");
    const stored = await deps.db.getAusdRelay(existing.id);
    if (stored?.authorization.signature.toLowerCase() !== payload.signature.toLowerCase()) {
      return errorJson(409, "authorization_reused", "This nonce was already used with a different signature.");
    }
    return awaitRelay(deps, ausd, invoice, merchant, existing.id, opts);
  }

  if (!payable(invoice, now)) return notOpen(invoice, now);
  if (await invoicePaidElsewhere(deps.db, invoice)) return errorJson(409, "invoice_paid", "This invoice is already being paid another way.");
  const fail = (reason: X402ErrorReason, message: string) =>
    paymentRequired(req, deps, ausd, invoice, merchant, now, message, failure(ausd, reason, from));

  if (accepted.scheme !== "exact") return fail("unsupported_scheme", `Only the "exact" scheme is accepted.`);
  if (accepted.network !== ausd.config.network) return fail("invalid_network", `Pay on ${ausd.config.network} (Base Sepolia).`);
  if (accepted.asset.toLowerCase() !== ausd.config.token.toLowerCase() || accepted.payTo.toLowerCase() !== ausd.config.payTo.toLowerCase()) {
    return fail("invalid_payment_requirements", "The accepted requirements aren't the ones this invoice offers.");
  }
  const quote = quoteFrom(accepted, invoice, Math.floor(now / 1000));
  if (!quote) return fail("quote_expired", "The price offer expired or isn't ours. Pay against the fresh requirements.");
  const amount = usdToAusdUnits(ausdCharge(quote), ausd.config.decimals);
  if (BigInt(accepted.amount) !== amount || BigInt(a.value) !== amount) {
    return fail("invalid_exact_evm_payload_authorization_value", `The authorization must move exactly ${amount} AUSD base units.`);
  }
  if (a.to.toLowerCase() !== ausd.config.payTo.toLowerCase()) {
    return fail("invalid_exact_evm_payload_recipient_mismatch", "The authorization must pay the payTo address.");
  }

  const message: TransferWithAuthorization = {
    from,
    to: getAddress(a.to),
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce as Hex,
  };
  const verdict = await verifyAusdAuthorization(ausd, message, payload.signature, Math.floor(now / 1000));
  if (!verdict.ok) {
    if (verdict.reason === "chain_unavailable") return errorJson(503, "chain_unavailable", verdict.message);
    return fail(REJECTION_REASON[verdict.reason], verdict.message);
  }

  let payment: Payment;
  try {
    payment = await deps.db.insertAusdPayment(
      {
        id: newId("pay"),
        merchantId: invoice.merchantId,
        source: invoice.kind,
        invoiceId: invoice.id,
        lines: invoice.lines,
        local: invoice.total,
        quote,
        charge: ausdCharge(quote),
        method: "ausd",
        payer: invoice.to,
      },
      toStoredAuthorization(message, payload.signature as Hex),
    );
  } catch (err) {
    if (!(err instanceof DbConflictError)) throw err;
    // A concurrent identical request won the insert: follow that payment.
    const winner = await deps.db.getPaymentByAusdNonce(from, a.nonce);
    if (!winner || winner.invoiceId !== invoice.id) return errorJson(409, "authorization_reused", "This authorization already paid for something else.");
    payment = winner;
  }
  return awaitRelay(deps, ausd, invoice, merchant, payment.id, opts);
}

/** Wait (bounded) for the worker relayer to land the transfer, then answer with the receipt. */
async function awaitRelay(
  deps: WebDeps,
  ausd: AusdDeps,
  invoice: Invoice,
  merchant: Merchant,
  paymentId: string,
  opts: X402Options,
): Promise<Response> {
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;
  let state = await deps.db.getAusdRelay(paymentId);
  while (state && state.payment.status === "created" && Date.now() < deadline) {
    await sleep(pollMs);
    state = await deps.db.getAusdRelay(paymentId);
  }
  if (!state) throw new Error(`x402 payment ${paymentId} lost its authorization`);

  const { payment, authorization } = state;
  const tx = state.payinTxHash ?? state.relayTxHash;
  const receipt = {
    paymentId: payment.id,
    status: payment.status,
    receiptUrl: links(deps.config.publicBaseUrl).receipt(payment.id),
    invoice: invoice.code,
    merchant: merchant.name,
    local: payment.local,
    ...(payment.charge ? { charge: payment.charge } : {}),
    ausd: {
      network: ausd.config.network,
      asset: ausd.config.token,
      amount: authorization.value,
      payer: authorization.from as Address,
      payTo: authorization.to,
      transaction: tx,
      explorerUrl: tx ? basescanTxUrl(tx) : null,
    },
  };

  if (PAID_OR_LATER.has(payment.status)) {
    const settled: SettlementResponse = {
      success: true,
      transaction: state.payinTxHash ?? "",
      network: ausd.config.network,
      payer: authorization.from,
      amount: authorization.value,
    };
    const headers = new Headers({ [X402_HEADERS.response]: encodeHeader(settled), [X402_HEADERS.legacyResponse]: encodeHeader(settled) });
    return json(receipt, { status: 200, headers });
  }
  if (payment.status === "failed") {
    const fail = failure(ausd, "settlement_failed", authorization.from, tx ?? "");
    const headers = new Headers({ [X402_HEADERS.response]: encodeHeader(fail), [X402_HEADERS.legacyResponse]: encodeHeader(fail) });
    return json({ ...receipt, error: "settlement_failed", message: state.failureReason ?? "The payment failed." }, { status: 402, headers });
  }
  // Still relaying: accepted, not done. Resend the same PAYMENT-SIGNATURE to get the final answer.
  return json({ ...receipt, message: "Payment accepted and relaying on Base Sepolia. Resend the same PAYMENT-SIGNATURE to get the result." }, { status: 202 });
}
