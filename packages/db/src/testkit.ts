// Helpers for this package's own tests (not exported from @rove/db). Other services use createTestDb().

import { money, newId, type Balance, type Merchant, type Money } from "@rove/shared";
import { seedDemoData } from "./demo";
import { makeDb, type MakeDbOptions } from "./impl";
import type { Db, NewPayment } from "./index";
import { freshPglite, pglitePool } from "./pglite";

export const sgd = (a: string): Money => money(a, "SGD");
export const usd = (a: string): Money => money(a, "USD");

/** A test db plus its raw pool (for asserting on rows the Db interface doesn't expose). */
export async function openTestDb(opts: MakeDbOptions & { demo?: boolean } = {}) {
  const pool = pglitePool(await freshPglite());
  if (opts.demo) await seedDemoData(pool);
  return { db: makeDb(pool, opts), pool };
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
