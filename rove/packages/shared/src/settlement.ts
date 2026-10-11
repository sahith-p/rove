// SettlementEngine: everything that touches XRPL. Implemented by packages/xrpl (Nithya).
// Mock: packages/shared/src/mocks/settlement.mock.ts (USE_MOCK_SETTLEMENT=1).

import type { Money } from "./money";
import type { MerchantId, PaymentId, Quote, WithdrawalId } from "./domain";

export interface SettleResult {
  txHash: string;
  /** meta.delivered_amount, decimal string, local currency */
  delivered: string;
  ledgerIndex: number;
}

export interface SettlementEngine {
  /** USD needed to deliver `local` via the RLUSD→XSGD pool. Valid ~60s. */
  quote(input: { local: Money }): Promise<Quote>;

  /** New merchant: custodial account, trust lines (XSGD, RLUSD), Credential issued + accepted. */
  createMerchantAccount(input: { merchantId: MerchantId }): Promise<{ xrplAddress: string; credentialStatus: "issued" | "accepted" }>;

  /** Treasury → merchant cross-currency Payment: Amount = local XSGD, SendMax = sendMaxUsd RLUSD. */
  settle(input: { paymentId: PaymentId; merchantAddress: string; local: Money; sendMaxUsd: string }): Promise<SettleResult>;

  /** Merchant XSGD back to the treasury (card refunds are paid to the customer by Stripe). */
  refund(input: { paymentId: PaymentId; merchantAddress: string; local: Money }): Promise<{ txHash: string }>;

  /** Withdrawal to bank, onchain half: merchant XSGD → redemption address (StraitsX in production). InvoiceID = withdrawal id. */
  sweepToRedemption(input: { withdrawalId: WithdrawalId; merchantAddress: string; local: Money }): Promise<{ txHash: string }>;

  /** Withdrawal to self-custody: merchant XSGD → the merchant's own XRPL wallet (needs an XSGD trust line). */
  sendToWallet(input: { withdrawalId: WithdrawalId; merchantAddress: string; local: Money; address: string }): Promise<{ txHash: string }>;

  /** XSGD balance on the merchant's custodial account (source of truth for funds). */
  balance(input: { merchantAddress: string }): Promise<Money>;

  /** Credential ROVE_VERIFIED_MERCHANT exists for this subject and is accepted. */
  isVerifiedMerchant(address: string): Promise<boolean>;

  explorerUrl(txHash: string): string;
}
