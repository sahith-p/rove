// Transaction builders: pure functions, no network. Every tx the engine and the seed submit is built here,
// so the unit tests cover exactly what goes on the ledger. Sequence/Fee/LastLedgerSequence come from autofill.

import { createHash } from "node:crypto";
import type { AccountSet, AMMCreate, Path, Payment, TrustSet } from "xrpl";
import { credentialTypeHex, type IssuedAmount } from "./currency";

/** asfDefaultRipple: issuers need it before any trust line exists, or tokens can't ripple through them / the AMM. */
export const ASF_DEFAULT_RIPPLE = 8;
/** lsfDefaultRipple on an AccountRoot. */
export const LSF_DEFAULT_RIPPLE = 0x00800000;
/** lsfAccepted on a Credential ledger entry. */
export const LSF_ACCEPTED = 0x00010000;
/** tfPartialPayment: we never set it (delivered_amount must equal Amount). */
export const TF_PARTIAL_PAYMENT = 0x00020000;

/** Trust line limit we open on every holder (well above any demo balance). */
export const DEFAULT_TRUST_LIMIT = "1000000000";

/** InvoiceID for a payment / withdrawal id: sha256 of the id, 64 upper-case hex. Links the tx to our row. */
export function invoiceIdFor(id: string): string {
  if (!id) throw new Error("invoiceIdFor: empty id");
  return createHash("sha256").update(id, "utf8").digest("hex").toUpperCase();
}

/**
 * Cross-currency settlement (from = "USD"): deliver exactly `amount` XSGD, spend at most `sendMax` RLUSD.
 * No tfPartialPayment, so it either delivers the full amount or fails (tecPATH_PARTIAL).
 */
export function buildCrossCurrencyPayment(input: {
  account: string;
  destination: string;
  amount: IssuedAmount;
  sendMax: IssuedAmount;
  invoiceId?: string;
  paths?: Path[];
}): Payment {
  if (input.amount.currency === input.sendMax.currency && input.amount.issuer === input.sendMax.issuer) {
    throw new Error("buildCrossCurrencyPayment: Amount and SendMax are the same asset; use buildIouPayment");
  }
  return {
    TransactionType: "Payment",
    Account: input.account,
    Destination: input.destination,
    Amount: { ...input.amount },
    SendMax: { ...input.sendMax },
    ...(input.invoiceId ? { InvoiceID: input.invoiceId } : {}),
    ...(input.paths && input.paths.length > 0 ? { Paths: input.paths } : {}),
  };
}

/** Same-currency token payment (XSGD → XSGD): settle from the SGD float, refund, sweep, send to wallet. */
export function buildIouPayment(input: { account: string; destination: string; amount: IssuedAmount; invoiceId?: string }): Payment {
  if (input.account === input.destination) throw new Error("buildIouPayment: account and destination are the same");
  return {
    TransactionType: "Payment",
    Account: input.account,
    Destination: input.destination,
    Amount: { ...input.amount },
    ...(input.invoiceId ? { InvoiceID: input.invoiceId } : {}),
  };
}

/** XRP payment in drops (merchant account funding). */
export function buildXrpPayment(input: { account: string; destination: string; drops: string }): Payment {
  if (!/^\d+$/.test(input.drops) || BigInt(input.drops) <= 0n) throw new Error(`buildXrpPayment: invalid drops ${input.drops}`);
  return { TransactionType: "Payment", Account: input.account, Destination: input.destination, Amount: input.drops };
}

export function buildTrustSet(input: { account: string; currency: string; issuer: string; limit?: string }): TrustSet {
  return {
    TransactionType: "TrustSet",
    Account: input.account,
    LimitAmount: { currency: input.currency, issuer: input.issuer, value: input.limit ?? DEFAULT_TRUST_LIMIT },
  };
}

export function buildDefaultRipple(account: string): AccountSet {
  return { TransactionType: "AccountSet", Account: account, SetFlag: ASF_DEFAULT_RIPPLE };
}

/** AMMCreate from the LP. TradingFee is in 1/100,000 (30 = 0.03%). autofill sets the special AMMCreate fee. */
export function buildAmmCreate(input: { account: string; amount: IssuedAmount; amount2: IssuedAmount; tradingFee: number }): AMMCreate {
  if (!Number.isInteger(input.tradingFee) || input.tradingFee < 0 || input.tradingFee > 1000) {
    throw new Error(`buildAmmCreate: TradingFee must be an integer 0..1000, got ${input.tradingFee}`);
  }
  return {
    TransactionType: "AMMCreate",
    Account: input.account,
    Amount: { ...input.amount },
    Amount2: { ...input.amount2 },
    TradingFee: input.tradingFee,
  };
}

// Credential txs exist in xrpl.js 4.x types; we build plain objects so older type packages still compile.
export interface CredentialCreateTx {
  TransactionType: "CredentialCreate";
  Account: string;
  Subject: string;
  CredentialType: string;
}
export interface CredentialAcceptTx {
  TransactionType: "CredentialAccept";
  Account: string;
  Issuer: string;
  CredentialType: string;
}

export function buildCredentialCreate(input: { issuer: string; subject: string; credentialType: string }): CredentialCreateTx {
  return {
    TransactionType: "CredentialCreate",
    Account: input.issuer,
    Subject: input.subject,
    CredentialType: credentialTypeHex(input.credentialType),
  };
}

export function buildCredentialAccept(input: { subject: string; issuer: string; credentialType: string }): CredentialAcceptTx {
  return {
    TransactionType: "CredentialAccept",
    Account: input.subject,
    Issuer: input.issuer,
    CredentialType: credentialTypeHex(input.credentialType),
  };
}
