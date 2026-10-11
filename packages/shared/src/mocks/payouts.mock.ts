// Mock PayoutPartners (USE_MOCK_PAYOUTS=1). The UI labels these payouts "simulated".
//   createMockPayoutPartner()      simulates StraitsX beneficiaries + FAST/PayNow payouts (SGD): reference "FAST-<6 digits>"
//   createMockSepaPayoutPartner()  simulates an IBAN beneficiary + SEPA Instant credit transfer (EUR): "SCTINST-<6 digits>"
//   createMockPayoutPartners()     both behind routePayoutPartners(), keyed by the registry's `payout` ids (straitsx, sepa)
// createBeneficiary → verified with a resolved holder name (upper-cased input).
// createPayout → pending, then completed after ~2s.
// MOCK_PAYOUT_FAIL=1 → payouts fail ("Account closed (simulated)"); the SEPA mock says "IBAN closed (simulated)".

import { randomInt } from "node:crypto";
import { routePayoutPartners, type Beneficiary, type BeneficiaryInput, type PartnerPayoutStatus, type PayoutPartner } from "../payouts";

interface MockRail {
  /** Prefix of beneficiary and payout ids, e.g. "sx" → sx_bene_…, sx_po_…. */
  idPrefix: string;
  reference: () => string;
  failureReason: string;
  last4: (input: BeneficiaryInput) => string;
}

function digitsLast4(input: BeneficiaryInput): string {
  const raw = input.accountNumber ?? input.proxy ?? "";
  return raw.replace(/\D/g, "").slice(-4) || raw.slice(-4);
}

function createMockRail(rail: MockRail, delayMs: number): PayoutPartner {
  const payouts = new Map<string, PartnerPayoutStatus>();
  const byKey = new Map<string, string>(); // idempotencyKey → partnerPayoutId
  const listeners = new Set<(s: PartnerPayoutStatus) => void>();

  return {
    async createBeneficiary(input): Promise<Beneficiary> {
      return {
        beneficiaryId: `${rail.idPrefix}_bene_${randomInt(1e9)}`,
        resolvedName: input.holderName.toUpperCase(),
        nameMatches: true,
        status: "verified",
        last4: rail.last4(input),
      };
    },

    async createPayout({ withdrawalId, idempotencyKey }) {
      const existing = byKey.get(idempotencyKey);
      if (existing) return payouts.get(existing)!;

      const partnerPayoutId = `${rail.idPrefix}_po_${randomInt(1e9)}`;
      const rec: PartnerPayoutStatus = { partnerPayoutId, withdrawalId, status: "pending" };
      payouts.set(partnerPayoutId, rec);
      byKey.set(idempotencyKey, partnerPayoutId);

      setTimeout(() => {
        const done: PartnerPayoutStatus =
          process.env.MOCK_PAYOUT_FAIL === "1"
            ? { partnerPayoutId, withdrawalId, status: "failed", failureReason: rail.failureReason }
            : { partnerPayoutId, withdrawalId, status: "completed", reference: rail.reference() };
        payouts.set(partnerPayoutId, done);
        listeners.forEach((cb) => cb(done));
      }, delayMs);

      return rec;
    },

    async getPayout(partnerPayoutId) {
      const rec = payouts.get(partnerPayoutId);
      if (!rec) throw new Error(`unknown payout ${partnerPayoutId}`);
      return rec;
    },

    onUpdate(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Simulated StraitsX (SGD): PayNow UEN / mobile / bank account beneficiaries, FAST payouts. */
export function createMockPayoutPartner(delayMs = 2000): PayoutPartner {
  return createMockRail(
    {
      idPrefix: "sx",
      reference: () => `FAST-${randomInt(100000, 999999)}`,
      failureReason: "Account closed (simulated)",
      last4: digitsLast4,
    },
    delayMs,
  );
}

/** Simulated SEPA payout partner (EUR): IBAN beneficiaries, SEPA Instant credit transfers. */
export function createMockSepaPayoutPartner(delayMs = 2000): PayoutPartner {
  return createMockRail(
    {
      idPrefix: "sepa",
      reference: () => `SCTINST-${randomInt(100000, 999999)}`,
      failureReason: "IBAN closed (simulated)",
      // An IBAN's last 4 characters (they can be letters in some countries).
      last4: (input) => (input.accountNumber ?? "").replace(/[\s-]/g, "").toUpperCase().slice(-4),
    },
    delayMs,
  );
}

/** Every simulated partner behind one PayoutPartner, routed by currency / account type (registry `payout` ids). */
export function createMockPayoutPartners(delayMs = 2000): PayoutPartner {
  return routePayoutPartners({ straitsx: createMockPayoutPartner(delayMs), sepa: createMockSepaPayoutPartner(delayMs) });
}
