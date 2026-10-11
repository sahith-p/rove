// Shared services for Nithya's API routes. Owner: Nithya (NI-C1). Server-side only (route handlers, runtime "nodejs").
//
//   const { db, settlement, stripe, emit } = getWebDeps();
//
// The web NEVER signs: settlement here is read-only (quote, verified badge, balance, explorer links). Only the worker
// moves money. The web never reads XRPL_*_SEED, WALLET_ENCRYPTION_KEY or BSC_DEPOSIT_MNEMONIC.
//   USE_MOCK_SETTLEMENT=1 → createMockSettlement()      else @rove/xrpl createXrplSettlement(xrplConfigFromEnv()) without seeds
//   USE_MOCK_PAYOUTS=1    → createMockPayoutPartner()   else: no real partner exists → error on first use
//   STRIPE_SECRET_KEY set → Stripe client               else null
// Tests: setWebDepsForTests(await createWebTestDeps()) (./testing.ts).

import Stripe from "stripe";
import { getDb, type Db } from "@rove/db";
import type { PayoutPartner, SettlementEngine } from "@rove/shared";
import { createMockPayoutPartner, createMockSettlement } from "@rove/shared/mocks";
import { createEmitter, type Emit } from "./emit";

/** What the web may ask the settlement engine. No settle / refund / sweep / send / createMerchantAccount. */
export type WebSettlement = Pick<SettlementEngine, "quote" | "isVerifiedMerchant" | "balance" | "explorerUrl">;

export interface WebConfig {
  publicBaseUrl: string;
  internalSecret: string;
  workerUrl: string;
  agentUrl: string;
  /** null when STRIPE_WEBHOOK_SECRET isn't set. */
  stripeWebhookSecret: string | null;
  useMockSettlement: boolean;
  useMockPayouts: boolean;
}

export interface WebDeps {
  db: Db;
  settlement: WebSettlement;
  payouts: PayoutPartner;
  stripe: Stripe | null;
  emit: Emit;
  config: WebConfig;
}

type Env = Record<string, string | undefined>;
const flag = (v: string | undefined) => v === "1" || v === "true";
const set = (v: string | undefined, placeholder?: string) => (v && v !== placeholder ? v : null);

/** Pure: no DB, no network. Safe to call anywhere server-side. */
export function webConfigFromEnv(env: Env = process.env): WebConfig {
  return {
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost:3000",
    internalSecret: env.INTERNAL_SECRET ?? "",
    workerUrl: env.WORKER_URL || "http://localhost:4001",
    agentUrl: env.AGENT_URL || "http://localhost:4002",
    stripeWebhookSecret: set(env.STRIPE_WEBHOOK_SECRET, "whsec_"),
    useMockSettlement: flag(env.USE_MOCK_SETTLEMENT),
    useMockPayouts: flag(env.USE_MOCK_PAYOUTS),
  };
}

export function xrplExplorerUrl(txHash: string): string {
  return `https://testnet.xrpl.org/transactions/${txHash}`;
}

/**
 * Real read-only engine, loaded on first use so routes that don't touch XRPL keep working.
 * TODO(NI-A3/NI-A4): apps/web needs `"@rove/xrpl": "workspace:*"` in package.json and "@rove/xrpl" in next.config
 * transpilePackages (requested from the owners). Then replace the throw with:
 *   const { createXrplSettlement, xrplConfigFromEnv } = await import("@rove/xrpl");
 *   return createXrplSettlement(xrplConfigFromEnv());   // no SeedStore: the web can't sign
 */
async function loadXrplReadOnly(): Promise<WebSettlement> {
  throw new Error(
    "Real XRPL settlement isn't wired into apps/web yet (needs @rove/xrpl as a web dependency, NI-A3). Set USE_MOCK_SETTLEMENT=1.",
  );
}

function lazyXrplSettlement(): WebSettlement {
  let engine: Promise<WebSettlement> | undefined;
  const get = () => (engine ??= loadXrplReadOnly().catch((err) => ((engine = undefined), Promise.reject(err))));
  return {
    quote: async (input) => (await get()).quote(input),
    isVerifiedMerchant: async (address) => (await get()).isVerifiedMerchant(address),
    balance: async (input) => (await get()).balance(input),
    explorerUrl: xrplExplorerUrl,
  };
}

function noPayoutPartner(): PayoutPartner {
  const fail = async (): Promise<never> => {
    throw new Error("No real payout partner is wired up (StraitsX API access isn't self-serve). Set USE_MOCK_PAYOUTS=1.");
  };
  return { createBeneficiary: fail, createPayout: fail, getPayout: fail, onUpdate: () => () => {} };
}

export function createWebDeps(env: Env = process.env): WebDeps {
  const config = webConfigFromEnv(env);
  const db = getDb();
  const stripeKey = set(env.STRIPE_SECRET_KEY, "sk_test_");
  return {
    db,
    settlement: config.useMockSettlement ? createMockSettlement() : lazyXrplSettlement(),
    payouts: config.useMockPayouts ? createMockPayoutPartner() : noPayoutPartner(),
    stripe: stripeKey ? new Stripe(stripeKey) : null,
    emit: createEmitter({ db, agentUrl: config.agentUrl, secret: config.internalSecret }),
    config,
  };
}

// Memoized per server process. Kept on globalThis so Next dev's module reloads don't create a new DB pool each time.
const KEY = Symbol.for("rove.webDeps");
type Holder = { [KEY]?: WebDeps };

export function getWebDeps(): WebDeps {
  const g = globalThis as Holder;
  return (g[KEY] ??= createWebDeps());
}

/** Inject deps (tests). Pass null to reset to env-built deps on next getWebDeps(). */
export function setWebDepsForTests(deps: WebDeps | null): void {
  const g = globalThis as Holder;
  if (deps) g[KEY] = deps;
  else delete g[KEY];
}
