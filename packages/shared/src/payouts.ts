// PayoutPartner: the off-chain half of a bank withdrawal. Redeemed XSGD becomes SGD in the merchant's bank
// over PayNow / FAST. Production: StraitsX (business account + API access via their sales team).
// Demo: packages/shared/src/mocks/payouts.mock.ts (USE_MOCK_PAYOUTS=1), labeled "simulated" in the UI.
// Statuses mirror StraitsX payout callbacks: pending | completed | failed (+ failure reason).
//
// One partner per currency (the registry's `payout` id: SGD → "straitsx", EUR → "sepa"). routePayoutPartners() puts
// several behind this same interface, routing by the payout's currency and the bank account's type.

import { payoutPartnerIdFor } from "./currencies";
import type { Currency, Money } from "./money";
import type { BankAccountType, MerchantId, WithdrawalId } from "./domain";

export interface BeneficiaryInput {
  merchantId: MerchantId;
  type: BankAccountType;
  bankName?: string;
  accountNumber?: string; // bank_account; for iban: the IBAN (normalized: no spaces, upper case)
  proxy?: string; // PayNow UEN or mobile
  holderName: string;
  /** The merchant's currency: which payout partner registers the account (routePayoutPartners). Default: by `type`. */
  currency?: Currency;
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

// ------------------------------------------------------------------ partners per currency

/** Which payout partner pays each bank-account type (= the registry `payout` id of the currency it serves). */
export const BANK_ACCOUNT_PARTNER: Record<BankAccountType, string> = {
  paynow_uen: "straitsx",
  paynow_mobile: "straitsx",
  bank_account: "straitsx",
  iban: "sepa",
};

/** Bank-account types a merchant in `currency` can add: SGD → PayNow UEN / mobile / bank account, EUR → IBAN.
 *  Empty when the currency has no payout partner (USD today): wallet withdrawals only. */
export function bankAccountTypesFor(currency: Currency): BankAccountType[] {
  const partner = payoutPartnerIdFor(currency);
  if (!partner) return [];
  return (Object.keys(BANK_ACCOUNT_PARTNER) as BankAccountType[]).filter((t) => BANK_ACCOUNT_PARTNER[t] === partner);
}

/** IBAN without spaces, upper case: "de89 3704 0044 0532 0130 00" → "DE89370400440532013000". */
export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/** ISO 13616 shape + mod-97 checksum (bigint-free: digit chunks). Accepts spaces and lower case. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/**
 * One PayoutPartner over several, keyed by partner id ({ straitsx, sepa }): createBeneficiary goes to the bank-account
 * type's partner (and refuses a type that can't receive the given currency), createPayout to the payout currency's
 * partner (registry `payout`), getPayout to whoever created that payout (else each partner in turn), and onUpdate
 * listens to all of them. A currency without a partner (USD today) throws: those merchants withdraw to a wallet.
 */
export function routePayoutPartners(partners: Readonly<Record<string, PayoutPartner>>): PayoutPartner {
  const owner = new Map<string, PayoutPartner>(); // partnerPayoutId → partner
  const pick = (id: string | null | undefined, what: string): PayoutPartner => {
    const p = id ? partners[id] : undefined;
    if (!p) throw new Error(`no payout partner for ${what}${id ? ` (partner "${id}" isn't configured)` : ""}`);
    return p;
  };

  return {
    async createBeneficiary(input) {
      const id = BANK_ACCOUNT_PARTNER[input.type];
      if (input.currency && payoutPartnerIdFor(input.currency) !== id) {
        throw new Error(`a ${input.type} account can't receive ${input.currency} payouts`);
      }
      return pick(id, `${input.type} accounts`).createBeneficiary(input);
    },

    async createPayout(input) {
      const partner = pick(payoutPartnerIdFor(input.amount.currency), `${input.amount.currency} payouts`);
      const s = await partner.createPayout(input);
      owner.set(s.partnerPayoutId, partner);
      return s;
    },

    async getPayout(partnerPayoutId) {
      const known = owner.get(partnerPayoutId);
      if (known) return known.getPayout(partnerPayoutId);
      let last: unknown = new Error(`unknown payout ${partnerPayoutId}`);
      for (const p of Object.values(partners)) {
        try {
          const s = await p.getPayout(partnerPayoutId);
          owner.set(partnerPayoutId, p);
          return s;
        } catch (err) {
          last = err;
        }
      }
      throw last;
    },

    onUpdate(cb) {
      const offs = Object.values(partners).map((p) => p.onUpdate(cb));
      return () => offs.forEach((off) => off());
    },
  };
}
