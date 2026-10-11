// Test-only helpers for settle (NI-C2) and refunds (NI-C5): a sleep-free engine that records calls, a fake Stripe,
// and fixtures on top of createTestDeps() (real SQL via PGlite).

import type { TestContext } from "node:test";
import type Stripe from "stripe";
import { createTestDb } from "@rove/db/testing";
import {
  fromMinor,
  money,
  newId,
  toMinor,
  type Currency,
  type Merchant,
  type Money,
  type Payment,
  type PaymentMethod,
  type PaymentSource,
  type Quote,
  type Recipient,
  type SettlementEngine,
} from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";
import type { WorkerDeps } from "../deps";
import { createLogger } from "../log";
import { createTestDeps, type TestDeps } from "../testing";

/** createTestDb() throws until NI-B1's PGlite helper lands; suites skip instead of failing `pnpm check`. */
export async function testDbAvailable(): Promise<boolean> {
  try {
    const db = await createTestDb();
    await db.close().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export const NO_TEST_DB = "createTestDb() isn't implemented on this branch yet (NI-B1)";

// ------------------------------------------------------------------ engine

export interface SettleCall {
  paymentId: string;
  merchantAddress: string;
  local: Money;
  sendMaxUsd: string;
  from: Currency | undefined;
}

export interface TestEngine {
  engine: SettlementEngine;
  calls: { quote: number; settle: SettleCall[]; refund: { paymentId: string; merchantAddress: string; local: Money }[] };
  /** Thrown by the next settle() calls, in order (then settle succeeds). */
  settleErrors: unknown[];
  /** Thrown by the next refund() calls, in order. */
  refundErrors: unknown[];
  /** Override what settle() reports as delivered. */
  delivered?: (local: Money) => string;
  /** XSGD cents per merchant address, moved by settle/refund. */
  balances: Map<string, bigint>;
  /** settle() takes this long (ms), so tests can observe concurrency. */
  settleDelayMs: number;
  /** Highest number of settle() calls in flight at once: overall and per merchant address. */
  maxConcurrent: { all: number; byAddress: Map<string, number> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The mock engine's quote math with no sleeps, recording every call. */
export function createTestEngine(): TestEngine {
  const base = createMockSettlement();
  const balances = new Map<string, bigint>();
  const active = { all: 0, byAddress: new Map<string, number>() };
  let n = 0;
  const t: TestEngine = {
    calls: { quote: 0, settle: [], refund: [] },
    settleErrors: [],
    refundErrors: [],
    balances,
    settleDelayMs: 0,
    maxConcurrent: { all: 0, byAddress: new Map() },
    engine: {
      ...base,
      async quote(input) {
        t.calls.quote++;
        return base.quote(input);
      },
      async settle(input) {
        t.calls.settle.push({ ...input, from: input.from });
        const addr = input.merchantAddress;
        active.all++;
        active.byAddress.set(addr, (active.byAddress.get(addr) ?? 0) + 1);
        t.maxConcurrent.all = Math.max(t.maxConcurrent.all, active.all);
        t.maxConcurrent.byAddress.set(addr, Math.max(t.maxConcurrent.byAddress.get(addr) ?? 0, active.byAddress.get(addr)!));
        try {
          if (t.settleDelayMs) await sleep(t.settleDelayMs);
          if (t.settleErrors.length) throw t.settleErrors.shift();
          balances.set(addr, (balances.get(addr) ?? 0n) + toMinor(input.local));
          return { txHash: `SETTLE${++n}`, delivered: t.delivered ? t.delivered(input.local) : input.local.amount, ledgerIndex: 1000 + n };
        } finally {
          active.all--;
          active.byAddress.set(addr, active.byAddress.get(addr)! - 1);
        }
      },
      async refund(input) {
        t.calls.refund.push({ ...input });
        if (t.refundErrors.length) throw t.refundErrors.shift();
        const cur = balances.get(input.merchantAddress) ?? 0n;
        if (cur < toMinor(input.local)) throw new Error("tecPATH_PARTIAL (test): insufficient XSGD");
        balances.set(input.merchantAddress, cur - toMinor(input.local));
        return { txHash: `REFUND${++n}` };
      },
      async balance({ merchantAddress }) {
        return fromMinor(balances.get(merchantAddress) ?? 0n, "SGD");
      },
    },
  };
  return t;
}

// ------------------------------------------------------------------ Stripe

export interface StripeCall {
  params: { payment_intent?: string; amount?: number };
  options: { idempotencyKey?: string } | undefined;
}

export interface FakeStripe {
  stripe: Stripe;
  calls: StripeCall[];
  /** Refunds Stripe actually created (one per idempotency key, like the real API). */
  created: Map<string, { id: string; amount: number | undefined; payment_intent: string | undefined }>;
  /** Make the next N calls throw. */
  failNext: number;
}

export function createFakeStripe(): FakeStripe {
  const f: FakeStripe = {
    calls: [],
    created: new Map(),
    failNext: 0,
    stripe: undefined as unknown as Stripe,
  };
  let n = 0;
  const refunds = {
    async create(params: StripeCall["params"], options?: StripeCall["options"]) {
      f.calls.push({ params, options });
      if (f.failNext > 0) {
        f.failNext--;
        throw new Error("Stripe is unavailable (fake)");
      }
      const key = options?.idempotencyKey ?? `nokey${++n}`;
      const prev = f.created.get(key);
      if (prev) return { ...prev, status: "succeeded" };
      const refund = { id: `re_test${++n}`, amount: params.amount, payment_intent: params.payment_intent };
      f.created.set(key, refund);
      return { ...refund, status: "succeeded" };
    },
  };
  f.stripe = { refunds } as unknown as Stripe;
  return f;
}

// ------------------------------------------------------------------ deps + fixtures

export interface Kit {
  deps: TestDeps;
  engine: TestEngine;
  stripe: FakeStripe;
  logs: string[];
}

export async function createKit(t: TestContext, overrides: Partial<WorkerDeps> = {}): Promise<Kit> {
  const engine = createTestEngine();
  const stripe = createFakeStripe();
  const logs: string[] = [];
  const deps = await createTestDeps({
    settlement: engine.engine,
    stripe: stripe.stripe,
    log: createLogger("test", { level: "debug", sink: (level, line) => logs.push(line) }),
    ...overrides,
  });
  t.after(() => deps.db.close().catch(() => {}));
  return { deps, engine, stripe, logs };
}

export const MAYA: Recipient = { phone: "+15555550199", channel: "imessage" };

let merchantSeq = 0;

export async function liveMerchant(deps: WorkerDeps, id = "ahseng"): Promise<Merchant> {
  const phone = `+1555556${String(++merchantSeq).padStart(4, "0")}`;
  await deps.db.upsertDraftMerchant({ id, name: "Ah Seng Chicken Rice", phone, channel: "imessage", category: "hawker", currency: "SGD" });
  await deps.db.setMerchantXrpl(id, { xrplAddress: `rTEST${id.toUpperCase()}`, xrplSeedEnc: "mock:no-seed", credentialStatus: "accepted" });
  return (await deps.db.setMerchantLive(id)) ?? (await deps.db.getMerchant(id))!;
}

export interface PaymentOpts {
  merchantId?: string;
  local?: string;
  /** Default: quote.usd (a USD payer). */
  charge?: Money;
  method?: PaymentMethod;
  /** Default: a fresh mock quote. */
  quote?: Quote | null;
  source?: PaymentSource;
  invoiceId?: string | null;
  payer?: Recipient | null;
  /** Default `pi_<paymentId>` for card / apple_pay, none for bnb. */
  paymentIntent?: string | null;
}

/** Inserts a payment and moves it created → authorized (what the Stripe webhook / BSC watcher do). */
export async function authorizedPayment(deps: WorkerDeps, o: PaymentOpts = {}): Promise<Payment> {
  const local = money(o.local ?? "12.50", "SGD");
  const quote = o.quote !== undefined ? o.quote : await createMockSettlement().quote({ local });
  const method = o.method ?? "apple_pay";
  const id = newId("pay");
  const pi = o.paymentIntent !== undefined ? o.paymentIntent : method === "bnb" ? null : `pi_${id}`;
  await deps.db.insertPayment({
    id,
    merchantId: o.merchantId ?? "ahseng",
    source: o.source ?? (o.invoiceId ? "invoice" : "fixed_qr"),
    invoiceId: o.invoiceId ?? null,
    lines: [],
    local,
    quote,
    charge: o.charge ?? quote?.usd ?? local,
    method,
    payer: o.payer === undefined ? MAYA : o.payer,
    ...(pi ? { stripePaymentIntentId: pi } : {}),
  });
  const p = await deps.db.transitionPayment(id, ["created"], "authorized");
  if (!p) throw new Error("fixture: could not authorize payment");
  return p;
}
