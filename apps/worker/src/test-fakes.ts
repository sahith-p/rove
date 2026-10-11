// Tiny in-memory stand-ins for the few Db / SettlementEngine methods NI-C1's tests touch. Unit tests only:
// anything bigger should use createTestDeps() (real SQL via PGlite) once NI-B1 lands.

import type { Db, NewDraftMerchant } from "@rove/db";
import { defaultCountryFor, type BankAccount, type CredentialStatus, type Currency, type EventEnvelope, type Merchant, type SettlementEngine } from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";

export interface FakeDb {
  db: Db;
  merchants: Map<string, Merchant & { seedEnc: string | null }>;
  bankAccounts: Map<string, BankAccount>;
  events: EventEnvelope[];
  delivered: Set<string>;
  calls: string[];
}

export function createFakeDb(): FakeDb {
  const merchants = new Map<string, Merchant & { seedEnc: string | null }>();
  const bankAccounts = new Map<string, BankAccount>();
  const events: EventEnvelope[] = [];
  const delivered = new Set<string>();
  const calls: string[] = [];
  const strip = (m: (Merchant & { seedEnc: string | null }) | undefined): Merchant | null => {
    if (!m) return null;
    const { seedEnc: _seed, ...rest } = m;
    return { ...rest };
  };

  const db = {
    async getMerchant(id: string) {
      calls.push("getMerchant");
      return strip(merchants.get(id));
    },
    async upsertDraftMerchant(m: NewDraftMerchant) {
      calls.push("upsertDraftMerchant");
      const prev = merchants.get(m.id);
      const row = prev
        ? { ...prev, name: m.name, category: m.category ?? prev.category }
        : {
            id: m.id,
            name: m.name,
            phone: m.phone,
            channel: m.channel,
            category: m.category ?? null,
            country: m.country ?? defaultCountryFor(m.currency ?? "SGD") ?? "SG",
            currency: m.currency ?? "SGD",
            xrplAddress: null,
            credentialStatus: "none" as CredentialStatus,
            autoWithdraw: "off" as const,
            status: "draft" as const,
            createdAt: new Date().toISOString(),
            seedEnc: null,
          };
      merchants.set(m.id, row);
      return strip(row)!;
    },
    async setMerchantXrpl(id: string, a: { xrplAddress: string; xrplSeedEnc: string; credentialStatus: CredentialStatus }) {
      calls.push("setMerchantXrpl");
      const prev = merchants.get(id);
      if (!prev) return null;
      const row = { ...prev, xrplAddress: a.xrplAddress, seedEnc: a.xrplSeedEnc, credentialStatus: a.credentialStatus };
      merchants.set(id, row);
      return strip(row);
    },
    async getMerchantSeedEnc(address: string) {
      calls.push("getMerchantSeedEnc");
      for (const m of merchants.values()) if (m.xrplAddress === address) return m.seedEnc;
      return null;
    },
    async setMerchantLive(id: string) {
      calls.push("setMerchantLive");
      const prev = merchants.get(id);
      if (!prev || prev.status !== "draft") return null;
      const row = { ...prev, status: "live" as const };
      merchants.set(id, row);
      return strip(row);
    },
    async getBankAccount(id: string) {
      return bankAccounts.get(id) ?? null;
    },
    async insertEvent(e: EventEnvelope) {
      events.push(e);
    },
    async markEventDelivered(id: string) {
      delivered.add(id);
    },
    async listUndeliveredEvents(limit = 100) {
      return events.filter((e) => !delivered.has(e.id)).slice(0, limit);
    },
  };

  return { db: db as unknown as Db, merchants, bankAccounts, events, delivered, calls };
}

/** Mock engine without the 800ms sleep, counting createMerchantAccount calls. `onCreate` runs inside it (seed store). */
export function createFastSettlement(onCreate?: (merchantId: string, address: string) => Promise<void>) {
  const base = createMockSettlement();
  const counts = { createMerchantAccount: 0, currencies: [] as (Currency | undefined)[] };
  const engine: SettlementEngine = {
    ...base,
    async createMerchantAccount({ merchantId, currency }) {
      counts.createMerchantAccount++;
      counts.currencies.push(currency);
      const xrplAddress = `rFAKE${merchantId.toUpperCase().replace(/[^A-Z0-9]/g, "")}${counts.createMerchantAccount}`;
      await onCreate?.(merchantId, xrplAddress);
      return { xrplAddress, credentialStatus: "accepted" };
    },
  };
  return { engine, counts };
}
