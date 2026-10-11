// Mock PayoutPartner (USE_MOCK_PAYOUTS=1): simulates StraitsX beneficiaries + FAST/PayNow payouts.
// createBeneficiary → verified with a resolved holder name (upper-cased input).
// createPayout → pending, then completed after ~2s with "FAST-<6 digits>".
// MOCK_PAYOUT_FAIL=1 → payouts fail ("Account closed (simulated)"). The UI labels these payouts "simulated".

import { randomInt } from "node:crypto";
import type { Beneficiary, PartnerPayoutStatus, PayoutPartner } from "../payouts";

export function createMockPayoutPartner(delayMs = 2000): PayoutPartner {
  const payouts = new Map<string, PartnerPayoutStatus>();
  const byKey = new Map<string, string>(); // idempotencyKey → partnerPayoutId
  const listeners = new Set<(s: PartnerPayoutStatus) => void>();

  return {
    async createBeneficiary(input): Promise<Beneficiary> {
      const raw = input.accountNumber ?? input.proxy ?? "";
      return {
        beneficiaryId: `sx_bene_${randomInt(1e9)}`,
        resolvedName: input.holderName.toUpperCase(),
        nameMatches: true,
        status: "verified",
        last4: raw.replace(/\D/g, "").slice(-4) || raw.slice(-4),
      };
    },

    async createPayout({ withdrawalId, idempotencyKey }) {
      const existing = byKey.get(idempotencyKey);
      if (existing) return payouts.get(existing)!;

      const partnerPayoutId = `sx_po_${randomInt(1e9)}`;
      const rec: PartnerPayoutStatus = { partnerPayoutId, withdrawalId, status: "pending" };
      payouts.set(partnerPayoutId, rec);
      byKey.set(idempotencyKey, partnerPayoutId);

      setTimeout(() => {
        const done: PartnerPayoutStatus =
          process.env.MOCK_PAYOUT_FAIL === "1"
            ? { partnerPayoutId, withdrawalId, status: "failed", failureReason: "Account closed (simulated)" }
            : { partnerPayoutId, withdrawalId, status: "completed", reference: `FAST-${randomInt(100000, 999999)}` };
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
