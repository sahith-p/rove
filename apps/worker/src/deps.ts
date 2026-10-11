// Everything a worker handler or job needs, built once at boot and passed as the first argument (`deps`).
// Owner: Nithya (NI-C1). Tests build the same shape with createTestDeps() (./testing.ts).
//
// Mock vs real (env, see .env.example):
//   USE_MOCK_SETTLEMENT=1 → createMockSettlement()          else createXrplSettlement(xrplConfigFromEnv(), seedStore) (@rove/xrpl)
//   USE_MOCK_PAYOUTS=1    → createMockPayoutPartner()       else: no real partner exists (StraitsX API isn't self-serve) → boot fails
//   STRIPE_SECRET_KEY set → Stripe client                   else stripe = null (refunds then fail with a clear error)
//   db                    → getDb() from @rove/db (DATABASE_URL)

import Stripe from "stripe";
import { getDb, type Db } from "@rove/db";
import type { MerchantId, PayoutPartner, SettlementEngine } from "@rove/shared";
import { createMockPayoutPartner, createMockSettlement } from "@rove/shared/mocks";
import { createEmitter, type Emit } from "./emit";
import { createLogger, type Logger } from "./log";

export interface WorkerConfig {
  port: number;
  /** Bearer token for /internal/* in both directions. */
  internalSecret: string;
  agentUrl: string;
  /** The web app's public URL (explorer/receipt links in logs and events). */
  publicBaseUrl: string;
  useMockSettlement: boolean;
  useMockPayouts: boolean;
  /** Background job periods (ms). */
  intervals: {
    settlePoll: number; // NI-C2: authorized payments the nudge missed
    expiry: number; // NI-C2: invoices / one-time QRs past expires_at
    reconcile: number; // NI-C7: ledger vs XRPL
    autoWithdraw: number; // NI-C4: how often to check whether the 21:00 SGT run is due
  };
}

export interface WorkerDeps {
  db: Db;
  settlement: SettlementEngine;
  payouts: PayoutPartner;
  /** null when STRIPE_SECRET_KEY isn't set (local dev without Stripe). */
  stripe: Stripe | null;
  emit: Emit;
  config: WorkerConfig;
  log: Logger;
  now(): Date;
}

type Env = Record<string, string | undefined>;

const flag = (v: string | undefined) => v === "1" || v === "true";
const int = (v: string | undefined, fallback: number) => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function configFromEnv(env: Env = process.env): WorkerConfig {
  const internalSecret = env.INTERNAL_SECRET ?? "";
  if (!internalSecret) throw new Error("INTERNAL_SECRET is not set (see .env.example)");
  return {
    port: int(env.PORT, 4001),
    internalSecret,
    agentUrl: env.AGENT_URL || "http://localhost:4002",
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost:3000",
    useMockSettlement: flag(env.USE_MOCK_SETTLEMENT),
    useMockPayouts: flag(env.USE_MOCK_PAYOUTS),
    intervals: {
      settlePoll: int(env.SETTLE_POLL_MS, 3000),
      expiry: int(env.EXPIRY_INTERVAL_MS, 60_000),
      reconcile: int(env.RECONCILE_INTERVAL_MS, 60_000),
      autoWithdraw: int(env.AUTO_WITHDRAW_CHECK_MS, 60_000),
    },
  };
}

// ------------------------------------------------------------------ XRPL seeds (demo custody)

/**
 * Where @rove/xrpl keeps a new merchant's AES-256-GCM-encrypted seed. Backed by the merchants row.
 * TODO(NI-A4): import this type from @rove/xrpl once it exports one; keep this adapter.
 */
export interface SeedStore {
  put(merchantId: MerchantId, address: string, seedEnc: string): Promise<void>;
  get(address: string): Promise<string | null>;
  findByMerchant?(merchantId: MerchantId): Promise<string | null>;
}

export function createSeedStore(db: Pick<Db, "setMerchantXrpl" | "getMerchantSeedEnc" | "getMerchant">): SeedStore {
  return {
    async put(merchantId, address, seedEnc) {
      // credentialStatus is recorded for real by the merchants route once createMerchantAccount returns.
      const row = await db.setMerchantXrpl(merchantId, { xrplAddress: address, xrplSeedEnc: seedEnc, credentialStatus: "none" });
      if (!row) throw new Error(`seed store: merchant ${merchantId} not found (create the draft first)`);
    },
    get: (address) => db.getMerchantSeedEnc(address),
    // Lets createMerchantAccount resume the account it already made instead of generating (and stranding) a second one.
    findByMerchant: async (merchantId) => (await db.getMerchant(merchantId))?.xrplAddress ?? null,
  };
}

/** The slice of @rove/xrpl the worker uses. Loaded dynamically so this file typechecks before NI-A3/NI-A4 land. */
interface XrplModule {
  createXrplSettlement: (config: unknown, seeds: SeedStore) => SettlementEngine | Promise<SettlementEngine>;
  xrplConfigFromEnv?: () => unknown;
}

/**
 * Real engine. TODO(NI-A3/NI-A4): once @rove/xrpl exports `createXrplSettlement(config, seedStore)` and
 * `xrplConfigFromEnv()`, replace the dynamic import with a static one.
 */
export async function createRealSettlement(seeds: SeedStore): Promise<SettlementEngine> {
  const mod = (await import("@rove/xrpl")) as unknown as XrplModule;
  if (typeof mod.xrplConfigFromEnv !== "function") {
    throw new Error("@rove/xrpl doesn't export xrplConfigFromEnv() yet (NI-A3). Set USE_MOCK_SETTLEMENT=1 until gate G1.");
  }
  return await mod.createXrplSettlement(mod.xrplConfigFromEnv(), seeds);
}

export function createPayouts(config: Pick<WorkerConfig, "useMockPayouts">): PayoutPartner {
  if (config.useMockPayouts) return createMockPayoutPartner();
  throw new Error("No real payout partner is wired up (StraitsX API access isn't self-serve). Set USE_MOCK_PAYOUTS=1.");
}

export function createStripe(env: Env = process.env): Stripe | null {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || key === "sk_test_") return null;
  return new Stripe(key);
}

export async function createDepsFromEnv(env: Env = process.env): Promise<WorkerDeps> {
  const config = configFromEnv(env);
  const log = createLogger("worker");
  const db = getDb();
  const settlement = config.useMockSettlement ? createMockSettlement() : await createRealSettlement(createSeedStore(db));
  const payouts = createPayouts(config);
  const stripe = createStripe(env);
  const emit = createEmitter({ db, agentUrl: config.agentUrl, secret: config.internalSecret, log: log.child("emit") });

  log.info("deps ready", {
    settlement: config.useMockSettlement ? "mock" : "xrpl",
    payouts: config.useMockPayouts ? "mock (simulated StraitsX)" : "real",
    stripe: stripe ? "on" : "off",
    agentUrl: config.agentUrl,
  });
  return { db, settlement, payouts, stripe, emit, config, log, now: () => new Date() };
}
