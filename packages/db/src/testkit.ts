// Helpers for this package's own tests (not exported from @rove/db). Other services use createTestDb().

import { randomUUID } from "node:crypto";
import { money, newId, type Balance, type Merchant, type Money } from "@rove/shared";
import { seedDemoData } from "./demo";
import { postgresPool, type Pool } from "./executor";
import { makeDb, type MakeDbOptions } from "./impl";
import type { Db, NewPayment } from "./index";
import { freshPglite, pglitePool, schemaSql } from "./pglite";

export const sgd = (a: string): Money => money(a, "SGD");
export const usd = (a: string): Money => money(a, "USD");

/**
 * A test db plus its raw pool (for asserting on rows the Db interface doesn't expose). PGlite by default.
 * With ROVE_DB_TEST_URL set (a scratch Postgres, never a real one), the same suite runs through postgres.js, the
 * production driver, each db in its own throwaway schema: `ROVE_DB_TEST_URL=postgres://… pnpm --filter @rove/db test`.
 */
export async function openTestDb(opts: MakeDbOptions & { demo?: boolean } = {}) {
  const url = process.env.ROVE_DB_TEST_URL;
  const pool = url ? await postgresSchemaPool(url) : pglitePool(await freshPglite());
  if (opts.demo) await seedDemoData(pool);
  return { db: makeDb(pool, opts), pool };
}

async function postgresSchemaPool(url: string): Promise<Pool> {
  const schema = `rove_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = postgresPool(url, { max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = postgresPool(url, { max: 4, searchPath: schema });
  await pool.query(schemaSql());
  return {
    query: pool.query,
    tx: pool.tx,
    async end() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}

let phoneSeq = 0;
export async function liveMerchant(db: Db, id: string, name = `Shop ${id}`, phone?: string): Promise<Merchant> {
  await db.upsertDraftMerchant({ id, name, phone: phone ?? `+659000${String(++phoneSeq).padStart(4, "0")}`, channel: "imessage", category: "hawker" });
  return (await db.setMerchantLive(id))!;
}

export function paymentInput(merchantId: string, local: Money, over: Partial<NewPayment> = {}): NewPayment {
  return {
    id: newId("pay"),
    merchantId,
    source: "fixed_qr",
    invoiceId: null,
    lines: [],
    local,
    quote: { local, usd: usd("9.72"), rate: "1.2860", sendMaxUsd: "9.79", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    charge: usd("9.72"),
    method: "card",
    payer: null,
    ...over,
  };
}

/** created → authorized → settling → settled, the way the webhook + worker do it. */
export async function settle(db: Db, p: NewPayment) {
  await db.insertPayment(p);
  await db.transitionPayment(p.id, ["created"], "authorized", { method: "apple_pay" });
  await db.transitionPayment(p.id, ["authorized"], "settling");
  return (await db.completeSettlement(p.id, { txHash: `TX${p.id}`, delivered: p.local.amount }))!;
}

/** [available, held, total] */
export const amounts = (b: Balance) => [b.available.amount, b.held.amount, b.total.amount];
