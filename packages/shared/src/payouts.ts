// PayoutPartner: the off-chain half of a bank withdrawal. Redeemed XSGD becomes SGD in the merchant's bank
// over PayNow / FAST. Production: StraitsX (business account + API access via their sales team).
// Demo: packages/shared/src/mocks/payouts.mock.ts (USE_MOCK_PAYOUTS=1), labeled "simulated" in the UI.
// Statuses mirror StraitsX payout callbacks: pending | completed | failed (+ failure reason).

import type { Money } from "./money";
import type { BankAccountType, MerchantId, WithdrawalId } from "./domain";

export interface BeneficiaryInput {
  merchantId: MerchantId;
  type: BankAccountType;
  bankName?: string;
  accountNumber?: string; // bank_account
  proxy?: string; // PayNow UEN or mobile
  holderName: string;
}

export interface Beneficiary {
  beneficiaryId: string;
  /** Name the partner/bank returned for the account (name enquiry). */
  resolvedName: string;
  nameMatches: boolean;
  status: "verified" | "pending" | "failed";
  last4: string;
}

export interface PartnerPayoutStatus {
  partnerPayoutId: string;
  withdrawalId: WithdrawalId;
  status: "pending" | "completed" | "failed";
  /** Bank-side reference, e.g. "FAST-881245". */
  reference?: string;
  failureReason?: string;
}

export interface PayoutPartner {
  /** Register a bank account / PayNow proxy. We keep only beneficiaryId + last4. */
  createBeneficiary(input: BeneficiaryInput): Promise<Beneficiary>;

  /** Pay SGD to a beneficiary. Dedupes on idempotencyKey (= withdrawalId). */
  createPayout(input: { withdrawalId: WithdrawalId; beneficiaryId: string; amount: Money; idempotencyKey: string }): Promise<PartnerPayoutStatus>;

  getPayout(partnerPayoutId: string): Promise<PartnerPayoutStatus>;

  /** Partner callbacks (webhooks in production; the mock fires after ~2s). Returns an unsubscribe fn. */
  onUpdate(cb: (s: PartnerPayoutStatus) => void): () => void;
}
