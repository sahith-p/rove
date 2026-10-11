// SettlementEngine: everything that touches XRPL. Implemented by packages/xrpl (Nithya).
// Mock: packages/shared/src/mocks/settlement.mock.ts (USE_MOCK_SETTLEMENT=1).

import type { Currency, Money } from "./money";
import type { MerchantId, PaymentId, Quote, WithdrawalId } from "./domain";

export interface SettleResult {
  txHash: string;
  /** meta.delivered_amount, decimal string, local currency */
  delivered: string;
  ledgerIndex: number;
}

// Currencies are data (currencies.ts). "local" = the merchant's currency; "from" = the payer's currency (which treasury
// float pays). Any enabled pair settles in ONE XRPL Payment: same currency → direct, else a market-rate swap through
// the RLUSD hub (e.g. EUR → RLUSD → XSGD). Defaults keep the original corridor: from USD, merchants in SGD.
export interface SettlementEngine {
  /** What the `from` float (default USD) spends to deliver exactly `local`. Valid ~60s. `usd`/`sendMaxUsd` are always
   *  filled (the USD route); `pay`/`sendMax` give the `from` route (rate = local per 1 `from`). */
  quote(input: { local: Money; from?: Currency }): Promise<Quote>;

  /** New merchant: custodial account, trust lines (their currency's stablecoin + RLUSD), Credential issued + accepted.
   *  `currency` = the merchant's currency (default SGD). */
  createMerchantAccount(input: { merchantId: MerchantId; currency?: Currency }): Promise<{ xrplAddress: string; credentialStatus: "issued" | "accepted" }>;

  /** Treasury → merchant Payment delivering exactly `local` (in the merchant's stablecoin). `from` = the payer's currency,
   *  i.e. which float pays: same as local = direct, no swap; else a swap through the RLUSD hub capped by SendMax =
   *  `sendMax` (quote.sendMax, in `from`), or `sendMaxUsd` when from is USD. Default from = "USD". */
  settle(input: { paymentId: PaymentId; merchantAddress: string; local: Money; sendMaxUsd: string; from?: Currency; sendMax?: string }): Promise<SettleResult>;

  /** Merchant stablecoin (local.currency) back to the treasury (card refunds are paid to the customer by Stripe). */
  refund(input: { paymentId: PaymentId; merchantAddress: string; local: Money }): Promise<{ txHash: string }>;

  /** Withdrawal to bank, onchain half: merchant stablecoin (local.currency) → redemption address (StraitsX for XSGD in
   *  production). InvoiceID = withdrawal id. */
  sweepToRedemption(input: { withdrawalId: WithdrawalId; merchantAddress: string; local: Money }): Promise<{ txHash: string }>;

  /** Withdrawal to self-custody: merchant stablecoin (local.currency) → the merchant's own XRPL wallet (needs a trust line for it). */
  sendToWallet(input: { withdrawalId: WithdrawalId; merchantAddress: string; local: Money; address: string }): Promise<{ txHash: string }>;

  /** The merchant's balance in `currency` (default SGD) on their custodial account (source of truth for funds). */
  balance(input: { merchantAddress: string; currency?: Currency }): Promise<Money>;

  /** Credential ROVE_VERIFIED_MERCHANT exists for this subject and is accepted. */
  isVerifiedMerchant(address: string): Promise<boolean>;

  explorerUrl(txHash: string): string;
}
