// Shared plumbing for the worker's live scripts (demo-reset.ts, e2e-smoke.ts). Owner: Nithya · NI-C7.
// Env: the process environment first, then ROVE_DOTENV (e.g. the main checkout's .env from a git worktree) or the
// repo-root .env if present; existing variables always win. Values are never printed.
// These scripts reach into packages/*/src by relative path for read-only helpers the packages don't export (raw
// ledger rows, raw trust-line balances); they aren't part of any build.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "@rove/db";
import type { Currency, EventEnvelope, RoveEvent } from "@rove/shared";
import { createMockPayoutPartners } from "@rove/shared/mocks";
import { createXrplSettlement, xrplConfigFromEnv, type XrplSettlementEngine } from "@rove/xrpl";
import { postgresPool, type Pool } from "../../../packages/db/src/executor";
import { findLine, getTrustLines } from "../../../packages/xrpl/src/ledger";
import { configFromEnv, createSeedStore, createStripe, type WorkerDeps } from "../src/deps";
import type { Emit } from "../src/emit";
import { createLogger, type Logger } from "../src/log";

/** Loads ROVE_DOTENV or the repo-root .env into process.env without overriding what's set. Returns the file used. */
export function loadEnv(): string | null {
  const path = process.env.ROVE_DOTENV || fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(path)) return null;
  process.loadEnvFile(path);
  return path;
}

/** Refuse anything but an XRPL test network (same rule as packages/xrpl/scripts). */
export function assertTestnet(): string {
  const wss = process.env.XRPL_WSS || "wss://s.altnet.rippletest.net:51233";
  const host = new URL(wss).hostname;
  if (!/altnet|testnet|devnet|^localhost$|^127\.0\.0\.1$/.test(host)) {
    throw new Error(`refusing to run against ${wss}: this script is for XRPL testnet only`);
  }
  return wss;
}

export function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** Records events instead of storing + POSTing them: a smoke run must not make the real agent text the demo phones. */
export function recordingEmitter(): { emit: Emit; events: RoveEvent[] } {
  const events: RoveEvent[] = [];
  const emit = async (event: RoveEvent) => void events.push(event);
  const deliver = async (_envelope: EventEnvelope) => true;
  return { emit: Object.assign(emit, { deliver }), events };
}

export interface LiveWorker {
  deps: WorkerDeps;
  engine: XrplSettlementEngine;
  db: Db;
  /** Raw SQL for read-only checks the Db contract doesn't expose (ledger rows by ref, entry counts). */
  sql: Pool;
  events: RoveEvent[];
  log: Logger;
  close(): Promise<void>;
}

/**
 * Worker deps against the REAL database + XRPL testnet (the merchant seed store is the DB), the mock payout partner,
 * Stripe from STRIPE_SECRET_KEY and a recording emitter. No jobs are started.
 */
export function liveWorker(opts: { db?: Db; scope?: string } = {}): LiveWorker {
  const log = createLogger(opts.scope ?? "smoke");
  const db = opts.db ?? createDb({ max: 3 });
  const sql = postgresPool(need("DATABASE_URL"), { max: 1 });
  const engine = createXrplSettlement(xrplConfigFromEnv(), { seedStore: createSeedStore(db), log: (line) => log.child("xrpl").info(line) });
  const config = { ...configFromEnv({ ...process.env, INTERNAL_SECRET: process.env.INTERNAL_SECRET || "smoke-local-only" }), useMockSettlement: false };
  const rec = recordingEmitter();
  const deps: WorkerDeps = {
    db,
    settlement: engine,
    payouts: createMockPayoutPartners(),
    stripe: createStripe(),
    emit: rec.emit,
    config,
    log,
    now: () => new Date(),
  };
  return {
    deps,
    engine,
    db,
    sql,
    events: rec.events,
    log,
    async close() {
      await Promise.allSettled([engine.close(), sql.end(), db.close()]);
    },
  };
}

/** The exact trust-line balance of `currency`'s stablecoin (XSGD for SGD) at `address` as XRPL reports it (no rounding), "0" if there is no line. */
export async function rawBalance(engine: XrplSettlementEngine, address: string, currency: Currency = "SGD"): Promise<string> {
  const asset = engine.context.asset(currency);
  const line = findLine(await getTrustLines(engine.context.conn, address, asset.issuer), asset.currency, asset.issuer);
  return line?.balance ?? "0";
}

/** A validated transaction by hash, straight from rippled. */
export async function fetchTx(engine: XrplSettlementEngine, hash: string): Promise<Record<string, any>> {
  const r = await engine.context.conn.run((c) => c.request({ command: "tx", transaction: hash }));
  return r.result as unknown as Record<string, any>;
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
