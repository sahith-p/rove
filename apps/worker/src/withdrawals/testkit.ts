// Test helpers for the withdrawal tests (NI-C3/NI-C4). Not a test file itself (the runner only picks up *.test.ts).
//
//   const skip = await dbSkipReason();                       // describe(..., { skip }) when createTestDb() doesn't work
//   after(closeFixtures);                                     // open PGlite instances keep the process alive
//   const fx = await withdrawalFixture({ balance: "118.40" }); // PGlite db, fast engine, live merchant, bank on file
//   await createWithdrawal(fx.deps, { merchantId: fx.merchantId, amount: "10", destination: null });

import { createTestDb } from "@rove/db/testing";
import {
  add,
  fromMinor,
  money,
  toMinor,
  type Currency,
  type Money,
  type PartnerPayoutStatus,
  type PayoutPartner,
  type SettlementEngine,
  type WithdrawalId,
  type WithdrawalStatus,
} from "@rove/shared";
import { createMockPayoutPartner, createMockPayoutPartners, createMockSettlement } from "@rove/shared/mocks";
import type { WorkerDeps } from "../deps";
import { createLogger, type LogLevel } from "../log";
import { createTestDeps, type TestDeps } from "../testing";

/** false when PGlite-backed createTestDb() works, else why the DB-backed tests are skipped. */
export async function dbSkipReason(): Promise<string | false> {
  try {
    const db = await createTestDb();
    await db.close();
    return false;
  } catch (err) {
    return `createTestDb() unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}

// ------------------------------------------------------------------ engine

export interface FastEngine {
  engine: SettlementEngine;
  calls: { settle: number; sweepToRedemption: number; sendToWallet: number };
  /** Make the next on-chain calls throw (sweep / sendToWallet), or the treasury return (settle). */
  fail: { onchain: Error | null; settle: Error | null };
  /** Addresses without an XSGD trust line: sendToWallet to them fails like the real engine (tecNO_LINE). */
  noTrustLine: Set<string>;
  /** While set, sweep / sendToWallet wait for this promise (to test re-executes mid-flight). */
  hold: Promise<void> | null;
  balanceOf(address: string): Money;
  credit(address: string, amount: Money): void;
  debit(address: string, amount: Money): void;
}

/** The mock engine's semantics (in-memory XSGD per address) without its 1.2-1.5s sleeps, with failure switches. */
export function createFastEngine(): FastEngine {
  const base = createMockSettlement(); // quote / explorerUrl / isVerifiedMerchant
  const balances = new Map<string, bigint>();
  const currencies = new Map<string, Currency>(); // address → the currency it holds (first credit decides; default SGD)
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const hash = (n: number) => `TX${String(n).padStart(62, "0")}`;
  let txs = 0;

  const fx: FastEngine = {
    engine: undefined as unknown as SettlementEngine,
    calls: { settle: 0, sweepToRedemption: 0, sendToWallet: 0 },
    fail: { onchain: null, settle: null },
    noTrustLine: new Set(),
    hold: null,
    balanceOf: (address) => fromMinor(balances.get(address) ?? 0n, currencies.get(address) ?? "SGD"),
    credit(address, amount) {
      if (!currencies.has(address)) currencies.set(address, amount.currency);
      balances.set(address, (balances.get(address) ?? 0n) + toMinor(amount));
    },
    debit(address, amount) {
      const cur = balances.get(address) ?? 0n;
      if (cur < toMinor(amount)) throw new Error("tecUNFUNDED_PAYMENT (fake): insufficient XSGD");
      balances.set(address, cur - toMinor(amount));
    },
  };

  const outgoing = async (merchantAddress: string, local: Money) => {
    await tick();
    if (fx.hold) await fx.hold;
    if (fx.fail.onchain) throw fx.fail.onchain;
    fx.debit(merchantAddress, local);
    return { txHash: hash(++txs) };
  };

  fx.engine = {
    ...base,
    async settle({ merchantAddress, local }) {
      fx.calls.settle++;
      await tick();
      if (fx.fail.settle) throw fx.fail.settle;
      fx.credit(merchantAddress, local);
      return { txHash: hash(++txs), delivered: local.amount, ledgerIndex: txs };
    },
    async refund({ merchantAddress, local }) {
      fx.debit(merchantAddress, local);
      return { txHash: hash(++txs) };
    },
    async sweepToRedemption({ merchantAddress, local }) {
      fx.calls.sweepToRedemption++;
      return outgoing(merchantAddress, local);
    },
    async sendToWallet({ merchantAddress, local, address }) {
      fx.calls.sendToWallet++;
      if (fx.noTrustLine.has(address)) {
        await tick();
        throw new Error(`tecNO_LINE: ${address} has no XSGD trust line`);
      }
      return outgoing(merchantAddress, local);
    },
    async balance({ merchantAddress }) {
      return fx.balanceOf(merchantAddress);
    },
  };
  return fx;
}

// ------------------------------------------------------------------ payout partner

export interface CountingPartner {
  partner: PayoutPartner;
  calls: { createPayout: number; getPayout: number };
}

/** The mock partner (callbacks after `delayMs`), counting calls. */
export function createCountingPartner(delayMs = 20): CountingPartner {
  const base = createMockPayoutPartner(delayMs);
  const calls = { createPayout: 0, getPayout: 0 };
  const partner: PayoutPartner = {
    ...base,
    createPayout(input) {
      calls.createPayout++;
      return base.createPayout(input);
    },
    getPayout(id) {
      calls.getPayout++;
      return base.getPayout(id);
    },
  };
  return { partner, calls };
}

/** A partner that never calls back: payouts stay pending until `decide(…)` changes what getPayout returns. */
export function createSilentPartner(): CountingPartner & { decide(withdrawalId: WithdrawalId, s: Partial<PartnerPayoutStatus>): void } {
  const calls = { createPayout: 0, getPayout: 0 };
  const byWithdrawal = new Map<string, PartnerPayoutStatus>();
  const byId = new Map<string, PartnerPayoutStatus>();
  let n = 0;
  const partner: PayoutPartner = {
    async createBeneficiary(input) {
      return { beneficiaryId: `bene_${++n}`, resolvedName: input.holderName.toUpperCase(), nameMatches: true, status: "verified", last4: "1234" };
    },
    async createPayout({ withdrawalId }) {
      calls.createPayout++;
      const existing = byWithdrawal.get(withdrawalId);
      if (existing) return existing;
      const rec: PartnerPayoutStatus = { partnerPayoutId: `po_${++n}`, withdrawalId, status: "pending" };
      byWithdrawal.set(withdrawalId, rec);
      byId.set(rec.partnerPayoutId, rec);
      return rec;
    },
    async getPayout(id) {
      calls.getPayout++;
      const rec = byId.get(id);
      if (!rec) throw new Error(`unknown payout ${id}`);
      return rec;
    },
    onUpdate: () => () => {},
  };
  return {
    partner,
    calls,
    decide(withdrawalId, s) {
      const rec = byWithdrawal.get(withdrawalId);
      if (!rec) throw new Error(`no payout for ${withdrawalId}`);
      const next = { ...rec, ...s };
      byWithdrawal.set(withdrawalId, next);
      byId.set(rec.partnerPayoutId, next);
    },
  };
}

// ------------------------------------------------------------------ fixture

export interface LogLine {
  level: LogLevel;
  line: string;
}

export interface WithdrawalFixture {
  deps: TestDeps;
  fast: FastEngine;
  merchantId: string;
  address: string;
  logs: LogLine[];
  /** Ledger payment_credit + the same XSGD on the (fake) chain, like a settled sale. */
  seed(amount: string): Promise<void>;
  /** Partner beneficiary + bank_accounts row (the merchant's first is the default). */
  addBank(opts?: { bankName?: string | null }): Promise<string>;
  /** Ledger available / held vs the merchant's XSGD balance; ok = available + held == balance. */
  reconciled(): Promise<Snapshot>;
  /** reconciled() taken at every withdrawal.updated this merchant emitted, in order. */
  snapshots: (Snapshot & { status: string })[];
}

export interface Snapshot {
  available: string;
  held: string;
  onchain: string;
  ok: boolean;
}

let merchantSeq = 0;

// An open PGlite instance keeps the test process alive, so every fixture's db is closed by closeFixtures()
// (call it from an after() hook in each test file).
const openDbs = new Set<WorkerDeps["db"]>();

export async function closeFixtures(): Promise<void> {
  const dbs = [...openDbs];
  openDbs.clear();
  await Promise.all(dbs.map((db) => db.close().catch(() => {})));
}

export async function withdrawalFixture(
  opts: {
    balance?: string;
    bank?: boolean;
    payouts?: PayoutPartner;
    overrides?: Partial<WorkerDeps>;
    merchantId?: string;
    /** The shop's currency (default SGD). EUR shops get an IBAN; the default partner routes SGD → StraitsX, EUR → SEPA. */
    currency?: Currency;
  } = {},
): Promise<WithdrawalFixture> {
  const fast = createFastEngine();
  const logs: LogLine[] = [];
  const log = createLogger("test", { level: "debug", sink: (level, line) => logs.push({ level, line }) });
  const deps = await createTestDeps({ settlement: fast.engine, payouts: opts.payouts ?? createMockPayoutPartners(20), log, ...opts.overrides });
  openDbs.add(deps.db);
  const fx = await addMerchant(deps, fast, opts.merchantId, opts.currency);
  const snapshots: WithdrawalFixture["snapshots"] = [];
  // Check the invariant at the moment each status is announced (still recorded in deps.events by the inner emitter).
  const inner = deps.emit;
  deps.emit = Object.assign(
    async (event: Parameters<typeof inner>[0]) => {
      if (event.type === "withdrawal.updated" && event.merchantId === fx.merchantId) snapshots.push({ status: event.status, ...(await fx.reconciled()) });
      await inner(event);
    },
    { deliver: inner.deliver },
  );
  const fixture: WithdrawalFixture = { ...fx, deps, fast, logs, snapshots };
  if (opts.bank ?? true) await fixture.addBank();
  if (opts.balance) await fixture.seed(opts.balance);
  return fixture;
}

/** Another live merchant on the same deps (for auto-withdraw and isolation tests). */
export async function addMerchant(
  deps: WorkerDeps,
  fast: FastEngine,
  id?: string,
  currency: Currency = "SGD",
): Promise<Pick<WithdrawalFixture, "merchantId" | "address" | "seed" | "addBank" | "reconciled">> {
  const n = ++merchantSeq;
  const merchantId = id ?? `shop-${n}`;
  const address = `rTEST${merchantId.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "x").padEnd(24, "x").slice(0, 28)}`;
  await deps.db.upsertDraftMerchant({
    id: merchantId,
    name: `Test Shop ${n}`,
    phone: `+1555000${String(n).padStart(4, "0")}`,
    channel: "imessage",
    currency,
  });
  await deps.db.setMerchantXrpl(merchantId, { xrplAddress: address, xrplSeedEnc: "enc:test", credentialStatus: "accepted" });
  await deps.db.setMerchantLive(merchantId);

  let credits = 0;
  return {
    merchantId,
    address,
    async seed(amount) {
      const m = money(amount, currency);
      await deps.db.appendLedger({ merchantId, kind: "payment_credit", amount: m, ref: `pay_seed_${merchantId}_${++credits}` });
      fast.credit(address, m);
    },
    async addBank(o = {}) {
      if (currency === "EUR") {
        const b = await deps.payouts.createBeneficiary({ merchantId, type: "iban", accountNumber: "DE89370400440532013000", holderName: "Test Shop", currency });
        const row = await deps.db.insertBankAccount({
          merchantId,
          type: "iban",
          bankName: o.bankName ?? null,
          last4: b.last4,
          holderName: b.resolvedName,
          beneficiaryId: b.beneficiaryId,
          status: b.status,
        });
        return row.id;
      }
      const b = await deps.payouts.createBeneficiary({ merchantId, type: "bank_account", bankName: "DBS", accountNumber: "0123451234", holderName: "Test Shop" });
      const row = await deps.db.insertBankAccount({
        merchantId,
        type: "bank_account",
        bankName: o.bankName === undefined ? "DBS" : o.bankName,
        last4: b.last4,
        holderName: b.resolvedName,
        beneficiaryId: b.beneficiaryId,
        status: b.status,
      });
      return row.id;
    },
    async reconciled() {
      const bal = await deps.db.getBalance(merchantId);
      const onchain = fast.balanceOf(address);
      const ok = toMinor(add(bal.available, bal.held)) === toMinor(onchain);
      return { available: bal.available.amount, held: bal.held.amount, onchain: onchain.amount, ok };
    },
  };
}

/** Polls until the withdrawal reaches one of `statuses` (or fails the test after `timeoutMs`). */
export async function waitForStatus(deps: Pick<WorkerDeps, "db">, id: WithdrawalId, statuses: WithdrawalStatus[], timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const w = await deps.db.getWithdrawal(id);
    if (w && statuses.includes(w.status)) return w;
    if (Date.now() > until) throw new Error(`withdrawal ${id} stuck at ${w?.status ?? "missing"} (wanted ${statuses.join("|")})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The withdrawal.updated statuses emitted for one withdrawal, in order. */
export function statusTrail(deps: TestDeps, id: WithdrawalId): WithdrawalStatus[] {
  return deps.events.flatMap((e) => (e.type === "withdrawal.updated" && e.withdrawalId === id ? [e.status] : []));
}
