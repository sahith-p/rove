// Any-to-any corridors (docs/specs/corridors.md): pure quote math per pair, 2-hop tx builders, config parsing, and the
// engine's quote/settle against a fake connection (no network) for a EUR → RLUSD → XSGD payment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { money, type Currency } from "@rove/shared";
import { Wallet, type TransactionMetadata } from "xrpl";
import type { XrplConnection } from "./client";
import { codeFor, issuerFor, xrplConfigFromEnv, type XrplConfig } from "./config";
import { createContext } from "./context";
import { currencyHex, issued } from "./currency";
import { createXrplSettlement } from "./engine";
import { XrplPathError, XrplTxError } from "./errors";
import { ammInputForOutput, buildPairQuote, buildQuote, chainInputForOutput, routeFor } from "./quote";
import { submitQueue } from "./queue";
import { deepenAmounts, HUB_POOLS, ROLE_KEYS } from "./setup";
import { deliveredMoney, sendMaxFor, toSettleResult } from "./settle";
import { buildAmmDepositTwoAsset, buildCrossCurrencyPayment, hubPaths, invoiceIdFor, TF_PARTIAL_PAYMENT, TF_TWO_ASSET } from "./tx";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const XSGD_HEX = "5853474400000000000000000000000000000000";

// Deep testnet pools from the seed: RLUSD/XSGD 1,000,000 / 1,290,000 and RLUSD/EUR 1,080,000 / 1,000,000, fee 30.
const USD_TO_SGD = { poolIn: "1000000", poolOut: "1290000", tradingFee: 30 };
const SGD_TO_USD = { poolIn: "1290000", poolOut: "1000000", tradingFee: 30 };
const USD_TO_EUR = { poolIn: "1080000", poolOut: "1000000", tradingFee: 30 };
const EUR_TO_USD = { poolIn: "1000000", poolOut: "1080000", tradingFee: 30 };

test("routeFor: same currency is direct, USD pairs are one hop, everything else goes through the RLUSD hub", () => {
  assert.deepEqual(routeFor("SGD", "SGD"), ["SGD"]);
  assert.deepEqual(routeFor("USD", "SGD"), ["USD", "SGD"]);
  assert.deepEqual(routeFor("EUR", "USD"), ["EUR", "USD"]);
  assert.deepEqual(routeFor("EUR", "SGD"), ["EUR", "USD", "SGD"]);
  assert.deepEqual(routeFor("SGD", "EUR"), ["SGD", "USD", "EUR"]);
});

test("chainInputForOutput = the legs applied back to front (EUR → RLUSD → XSGD)", () => {
  const rlusd = ammInputForOutput({ ...USD_TO_SGD, out: "12.50" });
  const eur = ammInputForOutput({ ...EUR_TO_USD, out: rlusd });
  assert.equal(chainInputForOutput([EUR_TO_USD, USD_TO_SGD], "12.50"), eur);
  assert.ok(rlusd.startsWith("9.69292425340369"), rlusd); // ≈ 12.50 / 1.29 / (1 − 0.0003)
  assert.ok(eur.startsWith("8.97770372546932"), eur); // ≈ that / 1.08 / (1 − 0.0003)
  assert.throws(() => chainInputForOutput([], "1"));
});

test("pair quote USD → SGD: identical to the original buildQuote, plus pay/sendMax mirrors", () => {
  const src = "9.702231717041783";
  const pair = buildPairQuote({ local: money("12.50", "SGD"), from: "USD", sourceValue: src, usdValue: src, now: NOW });
  const { pay, sendMax, ...rest } = pair;
  assert.deepEqual(rest, buildQuote(money("12.50", "SGD"), src, NOW));
  assert.deepEqual(pay, { amount: "9.71", currency: "USD" });
  assert.equal(sendMax, "9.81");
});

test("pair quote EUR → SGD (2 hops): pay in EUR rounded up, rate = SGD per EUR, usd = the USD route", () => {
  const eur = chainInputForOutput([EUR_TO_USD, USD_TO_SGD], "12.50");
  const usd = ammInputForOutput({ ...USD_TO_SGD, out: "12.50" });
  const q = buildPairQuote({ local: money("12.50", "SGD"), from: "EUR", sourceValue: eur, usdValue: usd, now: NOW });
  assert.deepEqual(q, {
    local: { amount: "12.50", currency: "SGD" },
    usd: { amount: "9.70", currency: "USD" },
    rate: "1.3919", // 12.50 / 8.98
    sendMaxUsd: "9.80",
    expiresAt: new Date(NOW + 60_000).toISOString(),
    pay: { amount: "8.98", currency: "EUR" },
    sendMax: "9.07", // 8.98 × 1.01 = 9.0698 → 9.07
  });
});

test("pair quote USD → EUR (1 hop) and SGD → EUR (2 hops)", () => {
  const usdEur = ammInputForOutput({ ...USD_TO_EUR, out: "9.50" });
  const a = buildPairQuote({ local: money("9.50", "EUR"), from: "USD", sourceValue: usdEur, usdValue: usdEur, now: NOW });
  assert.deepEqual([a.pay, a.sendMax, a.usd, a.sendMaxUsd, a.rate], [{ amount: "10.27", currency: "USD" }, "10.38", { amount: "10.27", currency: "USD" }, "10.38", "0.9250"]);

  const sgdEur = chainInputForOutput([SGD_TO_USD, USD_TO_EUR], "4.20");
  const usd = ammInputForOutput({ ...USD_TO_EUR, out: "4.20" });
  const b = buildPairQuote({ local: money("4.20", "EUR"), from: "SGD", sourceValue: sgdEur, usdValue: usd, now: NOW });
  assert.deepEqual([b.pay, b.sendMax, b.usd, b.sendMaxUsd, b.rate], [{ amount: "5.86", currency: "SGD" }, "5.92", { amount: "4.54", currency: "USD" }, "4.59", "0.7167"]);
});

test("pair quote to a USD merchant: usd = local, no slippage on the USD route", () => {
  const eurUsd = ammInputForOutput({ ...EUR_TO_USD, out: "10.00" });
  const q = buildPairQuote({ local: money("10.00", "USD"), from: "EUR", sourceValue: eurUsd, usdValue: "", now: NOW });
  assert.deepEqual([q.pay, q.sendMax, q.usd, q.sendMaxUsd, q.rate], [{ amount: "9.27", currency: "EUR" }, "9.37", { amount: "10.00", currency: "USD" }, "10.00", "1.0787"]);
});

test("pair quote, same currency: pay = local, sendMax = local, rate 1 (no swap)", () => {
  for (const [c, amount] of [["EUR", "3.00"], ["SGD", "6.50"], ["USD", "10.00"]] as [Currency, string][]) {
    const q = buildPairQuote({ local: money(amount, c), from: c, sourceValue: "ignored", usdValue: "3.2412", now: NOW });
    assert.deepEqual([q.pay, q.sendMax, q.rate], [{ amount, currency: c }, amount, "1.0000"], c);
  }
  // usd is still the USD route's value for a non-USD local
  assert.equal(buildPairQuote({ local: money("3.00", "EUR"), from: "EUR", sourceValue: "", usdValue: "3.2412", now: NOW }).usd.amount, "3.25");
});

test("pair quote rejects zero amounts and zero/negative sources", () => {
  assert.throws(() => buildPairQuote({ local: money("0.00", "EUR"), from: "EUR", sourceValue: "", usdValue: "1", now: NOW }));
  assert.throws(() => buildPairQuote({ local: money("1.00", "EUR"), from: "SGD", sourceValue: "0", usdValue: "1", now: NOW }));
  assert.throws(() => buildPairQuote({ local: money("1.00", "EUR"), from: "SGD", sourceValue: "-1", usdValue: "1", now: NOW }));
  assert.throws(() => buildQuote(money("1.00", "USD"), "1", NOW)); // the original USD-route builder still refuses USD → USD
});

test("2-hop tx builders: hub path, EUR SendMax, exact XSGD Amount, no partial payments", () => {
  const usdIssuer = Wallet.generate().address;
  const sgdIssuer = Wallet.generate().address;
  const eurIssuer = Wallet.generate().address;
  const paths = hubPaths({ currency: RLUSD_HEX, issuer: usdIssuer }, { currency: XSGD_HEX, issuer: sgdIssuer });
  assert.deepEqual(paths, [[{ currency: RLUSD_HEX, issuer: usdIssuer }, { currency: XSGD_HEX, issuer: sgdIssuer }]]);
  const tx = buildCrossCurrencyPayment({
    account: "rTreasury",
    destination: "rMerchant",
    amount: issued("XSGD", sgdIssuer, "12.50"),
    sendMax: issued("EUR", eurIssuer, "9.07"),
    invoiceId: invoiceIdFor("pay_eur"),
    paths,
  });
  assert.deepEqual(tx.Amount, { currency: XSGD_HEX, issuer: sgdIssuer, value: "12.50" });
  assert.deepEqual(tx.SendMax, { currency: "EUR", issuer: eurIssuer, value: "9.07" }); // 3-char codes stay as-is
  assert.deepEqual(tx.Paths, paths);
  assert.equal(((tx.Flags as number | undefined) ?? 0) & TF_PARTIAL_PAYMENT, 0);
  assert.throws(() => hubPaths({ currency: RLUSD_HEX, issuer: usdIssuer }, { currency: RLUSD_HEX, issuer: usdIssuer }));
});

test("AMMDeposit two-asset (deepen a pool without moving its price)", () => {
  const tx = buildAmmDepositTwoAsset({ account: "rLP", amount: issued("RLUSD", "rUsd", "989964.98"), amount2: issued("XSGD", "rSgd", "1269427.51") });
  assert.deepEqual(tx, {
    TransactionType: "AMMDeposit",
    Account: "rLP",
    Asset: { currency: RLUSD_HEX, issuer: "rUsd" },
    Asset2: { currency: XSGD_HEX, issuer: "rSgd" },
    Amount: { currency: RLUSD_HEX, issuer: "rUsd", value: "989964.98" },
    Amount2: { currency: XSGD_HEX, issuer: "rSgd", value: "1269427.51" },
    Flags: TF_TWO_ASSET,
  });
  assert.equal(TF_TWO_ASSET, 0x00100000);
});

test("deepenAmounts: shallow pool → deposit to the target at the current ratio (+0.1%); deep pool → nothing", () => {
  const pool = (usd: string, sgd: string) => ({ amount: { currency: RLUSD_HEX, issuer: "r", value: usd }, amount2: { currency: XSGD_HEX, issuer: "r", value: sgd } });
  // The real pre-deepen testnet pool (drifted from 1.29 by earlier settlements).
  assert.deepEqual(deepenAmounts(pool("10035.01635110974", "12855"), HUB_POOLS.SGD as { usd: string; minHubDepth: string }), {
    usd: "989964.983649",
    local: "1269427.514526",
  });
  assert.equal(deepenAmounts(pool("1000000", "1281000"), { usd: "1000000", minHubDepth: "500000" }), null);
});

test("seed roles: one issuer per enabled currency, existing env names kept", () => {
  assert.deepEqual(ROLE_KEYS.USD_ISSUER, { seed: "XRPL_USD_ISSUER_SEED", address: "XRPL_USD_ISSUER" });
  assert.deepEqual(ROLE_KEYS.SGD_ISSUER, { seed: "XRPL_SGD_ISSUER_SEED", address: "XRPL_SGD_ISSUER" });
  assert.deepEqual(ROLE_KEYS.EUR_ISSUER, { seed: "XRPL_ISSUER_EUR_SEED", address: "XRPL_ISSUER_EUR" });
  assert.equal(Object.keys(ROLE_KEYS)[0], "USD_ISSUER");
});

const A = {
  usd: "rH15tHofyKyTfoCKHx9C839K2VS55sewLg",
  sgd: "rwkaqG93nQBqkSqosVfqUqjLcH5hizMMJd",
  eur: "rUhv2j8yKAa8XoTMihApuUmKJcvBSP8b8f",
  treasury: "rDAjoXuxGgqrqfivKWpLCsqCDggaWFcXCS",
};

test("config: every enabled currency's issuer from env; old names kept; generic XRPL_ISSUER_<CODE> accepted", () => {
  const c = xrplConfigFromEnv({ XRPL_USD_ISSUER: A.usd, XRPL_SGD_ISSUER: A.sgd, XRPL_ISSUER_EUR: A.eur });
  assert.deepEqual(c.issuers, { USD: A.usd, SGD: A.sgd, EUR: A.eur });
  assert.equal(c.usdIssuer, A.usd);
  assert.equal(c.sgdIssuer, A.sgd);
  // generic names work for USD/SGD too; the registry's name wins when both are set
  assert.equal(xrplConfigFromEnv({ XRPL_ISSUER_SGD: A.eur }).sgdIssuer, A.eur);
  assert.equal(xrplConfigFromEnv({ XRPL_ISSUER_SGD: A.eur, XRPL_SGD_ISSUER: A.sgd }).sgdIssuer, A.sgd);
  assert.deepEqual(xrplConfigFromEnv({}).issuers, {});
  // literal configs without `issuers` (older callers) still resolve USD/SGD
  const literal: XrplConfig = { wss: "wss://x", usdIssuer: A.usd, sgdIssuer: A.sgd, treasuryAddress: A.treasury };
  assert.equal(issuerFor(literal, "SGD"), A.sgd);
  assert.equal(issuerFor(literal, "EUR"), "");
  assert.deepEqual([codeFor(literal, "USD"), codeFor(literal, "SGD"), codeFor(literal, "EUR")], ["RLUSD", "XSGD", "EUR"]);
  assert.equal(codeFor({ ...literal, sgdCode: "XSGD2" }, "SGD"), "XSGD2");
});

test("context.asset: hex codes for long codes, 3-char as-is, missing issuer names its env var", () => {
  const ctx = createContext(xrplConfigFromEnv({ XRPL_USD_ISSUER: A.usd, XRPL_SGD_ISSUER: A.sgd }), { connection: {} as XrplConnection });
  assert.deepEqual(ctx.asset("SGD"), { currency: XSGD_HEX, issuer: A.sgd });
  assert.deepEqual(ctx.usd(), { currency: RLUSD_HEX, issuer: A.usd });
  assert.throws(() => ctx.asset("EUR"), /XRPL_ISSUER_EUR is not set/);
  assert.throws(() => ctx.asset("INR" as Currency), /not an enabled currency/);
  const withEur = createContext(xrplConfigFromEnv({ XRPL_ISSUER_EUR: A.eur }), { connection: {} as XrplConnection });
  assert.deepEqual(withEur.asset("EUR"), { currency: "EUR", issuer: A.eur });
  assert.equal(withEur.tokenName("SGD"), "XSGD");
});

const meta = (delivered: unknown) => ({ TransactionResult: "tesSUCCESS", AffectedNodes: [], TransactionIndex: 0, delivered_amount: delivered }) as unknown as TransactionMetadata;

test("deliveredMoney / toSettleResult in EUR: exact amount of our token or an error", () => {
  const eur = { currency: "EUR", issuer: A.eur };
  assert.deepEqual(deliveredMoney(meta({ ...eur, value: "9.5" }), eur, "EUR"), { amount: "9.50", currency: "EUR" });
  assert.throws(() => deliveredMoney(meta({ ...eur, issuer: A.usd, value: "9.5" }), eur, "EUR"), /is not EUR from/);
  assert.throws(() => deliveredMoney(meta({ ...eur, value: "9.499" }), eur, "EUR"), /whole number of cents/);
  const outcome = { hash: "H", ledgerIndex: 1, result: "tesSUCCESS", meta: meta({ ...eur, value: "9.5" }), tx: {} };
  assert.deepEqual(toSettleResult(outcome, money("9.50", "EUR"), eur), { txHash: "H", delivered: "9.50", ledgerIndex: 1 });
  assert.throws(() => toSettleResult(outcome, money("9.51", "EUR"), eur), XrplTxError);
});

test("sendMaxFor: non-USD payers need quote.sendMax; USD falls back to sendMaxUsd", () => {
  assert.deepEqual(sendMaxFor({ sendMaxUsd: "9.81" }, "USD", "SGD"), { amount: "9.81", currency: "USD" });
  assert.deepEqual(sendMaxFor({ sendMaxUsd: "9.81", sendMax: "9.07" }, "EUR", "SGD"), { amount: "9.07", currency: "EUR" });
  assert.throws(() => sendMaxFor({ sendMaxUsd: "9.81" }, "EUR", "SGD"), /sendMax \(quote.sendMax, in EUR\) is required for a EUR → SGD/);
  assert.throws(() => sendMaxFor({ sendMaxUsd: "0" }, "USD", "SGD"), /sendMaxUsd must be positive/);
});

// ------------------------------------------------------------------ engine against a fake connection (no network)

interface Fake {
  conn: XrplConnection;
  requests: Record<string, unknown>[];
  submitted: Record<string, unknown>[];
}

/** A fake rippled: path_find answers per source currency, account_tx is empty, every submit validates with
 *  delivered_amount = Amount. `pathFind` may throw to exercise the amm_info fallback. */
function fakeRippled(opts: {
  pathFind: (req: Record<string, unknown>) => { source_amount: unknown; paths_computed: unknown[] }[];
  amm?: (req: Record<string, unknown>) => unknown;
}): Fake {
  const requests: Record<string, unknown>[] = [];
  const submitted: Record<string, unknown>[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const client = {
    async request(req: Record<string, unknown>) {
      requests.push(req);
      switch (req.command) {
        case "ripple_path_find":
          return { result: { alternatives: opts.pathFind(req) } };
        case "amm_info":
          return { result: { amm: opts.amm?.(req) } };
        case "account_tx":
          return { result: { transactions: [] } };
        case "submit": {
          const { decode, hashes } = await import("xrpl");
          const blob = req.tx_blob as string;
          const tx = decode(blob) as Record<string, unknown>;
          submitted.push(tx);
          const hash = hashes.hashSignedTx(blob);
          results.set(hash, { tx_json: tx, hash, ledger_index: 99, validated: true, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [], TransactionIndex: 0, delivered_amount: tx.Amount } });
          return { result: { engine_result: "tesSUCCESS" } };
        }
        case "tx": {
          const r = results.get(req.transaction as string);
          if (!r) throw Object.assign(new Error("txnNotFound"), { data: { error: "txnNotFound" } });
          return { result: r };
        }
        default:
          throw new Error(`fake rippled: unexpected ${String(req.command)}`);
      }
    },
    async autofill(tx: Record<string, unknown>) {
      return { ...tx, Fee: "12", Sequence: 1, LastLedgerSequence: 1000 };
    },
    async getLedgerIndex() {
      return 99;
    },
  };
  const conn = { run: async <T>(fn: (c: typeof client) => Promise<T>) => fn(client), close: async () => undefined } as unknown as XrplConnection;
  return { conn, requests, submitted };
}

function fakeEngine(fake: Fake, treasury: Wallet) {
  const config: XrplConfig = {
    ...xrplConfigFromEnv({ XRPL_USD_ISSUER: A.usd, XRPL_SGD_ISSUER: A.sgd, XRPL_ISSUER_EUR: A.eur }),
    treasuryAddress: treasury.address,
    treasurySeed: treasury.seed,
  };
  return createXrplSettlement(config, { connection: fake.conn, queue: submitQueue, log: () => undefined });
}

const sourceCurrency = (req: Record<string, unknown>) => (req.source_currencies as { currency: string }[])[0]?.currency;

test("engine.quote({ from: EUR }) runs the EUR route and the USD route; pay/sendMax from EUR, usd from RLUSD", async () => {
  const fake = fakeRippled({
    pathFind: (req) =>
      sourceCurrency(req) === "EUR"
        ? [{ source_amount: { currency: "EUR", issuer: A.eur, value: "8.977703725469324" }, paths_computed: [] }]
        : [{ source_amount: { currency: RLUSD_HEX, issuer: A.usd, value: "9.692924253403697" }, paths_computed: [] }],
  });
  const engine = fakeEngine(fake, Wallet.generate());
  const q = await engine.quote({ local: money("12.50", "SGD"), from: "EUR" });
  assert.deepEqual([q.pay, q.sendMax, q.rate, q.usd.amount, q.sendMaxUsd], [{ amount: "8.98", currency: "EUR" }, "9.07", "1.3919", "9.70", "9.80"]);
  assert.equal(fake.requests.filter((r) => r.command === "ripple_path_find").length, 2);
  // Without `from`: the original USD route (one path_find), pay mirrors usd.
  const before = fake.requests.length;
  const u = await engine.quote({ local: money("12.50", "SGD") });
  assert.deepEqual([u.usd.amount, u.sendMaxUsd, u.pay?.amount, u.rate], ["9.70", "9.80", "9.70", "1.2886"]);
  assert.equal(fake.requests.length - before, 1);
  // Same currency: no network at all for the EUR route.
  const s = await engine.quote({ local: money("3.00", "EUR"), from: "EUR" });
  assert.deepEqual([s.pay?.amount, s.sendMax, s.rate], ["3.00", "3.00", "1.0000"]);
});

test("engine.quote falls back to amm_info math along the hub route when path finding fails", async () => {
  const pools: Record<string, { amount: unknown; amount2: unknown }> = {
    EUR: { amount: { currency: "EUR", issuer: A.eur, value: "1000000" }, amount2: { currency: RLUSD_HEX, issuer: A.usd, value: "1080000" } },
    [XSGD_HEX]: { amount: { currency: RLUSD_HEX, issuer: A.usd, value: "1000000" }, amount2: { currency: XSGD_HEX, issuer: A.sgd, value: "1290000" } },
  };
  const fake = fakeRippled({
    pathFind: () => {
      throw new Error("pathfinding busy");
    },
    amm: (req) => {
      const a = (req.asset as { currency: string }).currency;
      const b = (req.asset2 as { currency: string }).currency;
      const key = a === RLUSD_HEX ? b : a;
      return { account: `rAMM${key.slice(0, 3)}`, trading_fee: 30, ...pools[key] };
    },
  });
  const q = await fakeEngine(fake, Wallet.generate()).quote({ local: money("12.50", "SGD"), from: "EUR" });
  assert.deepEqual([q.pay?.amount, q.usd.amount], ["8.98", "9.70"]);
  assert.equal(fake.requests.filter((r) => r.command === "amm_info").length, 3); // EUR/RLUSD + RLUSD/XSGD, and RLUSD/XSGD for usd
});

test("engine.settle EUR → SGD: ONE Payment, exact XSGD Amount, EUR SendMax, hub path; refuses a SendMax the pools exceed", async () => {
  const treasury = Wallet.generate();
  const merchant = Wallet.generate().address;
  const hub = [[{ currency: RLUSD_HEX, issuer: A.usd }, { currency: XSGD_HEX, issuer: A.sgd }]];
  const fake = fakeRippled({ pathFind: () => [{ source_amount: { currency: "EUR", issuer: A.eur, value: "8.977703725469324" }, paths_computed: hub }] });
  const engine = fakeEngine(fake, treasury);
  const res = await engine.settle({ paymentId: "pay_eur1", merchantAddress: merchant, local: money("12.50", "SGD"), sendMaxUsd: "9.80", from: "EUR", sendMax: "9.07" });
  assert.equal(res.delivered, "12.50");
  assert.equal(fake.submitted.length, 1);
  const tx = fake.submitted[0] as Record<string, unknown>;
  assert.equal(tx.TransactionType, "Payment");
  assert.equal(tx.Account, treasury.address);
  assert.equal(tx.Destination, merchant);
  assert.deepEqual(tx.Amount, { currency: XSGD_HEX, issuer: A.sgd, value: "12.5" });
  assert.deepEqual(tx.SendMax, { currency: "EUR", issuer: A.eur, value: "9.07" });
  assert.deepEqual(tx.Paths, hub);
  assert.equal(tx.InvoiceID, invoiceIdFor("pay_eur1"));
  assert.equal(((tx.Flags as number | undefined) ?? 0) & TF_PARTIAL_PAYMENT, 0);

  await assert.rejects(
    engine.settle({ paymentId: "pay_eur2", merchantAddress: merchant, local: money("12.50", "SGD"), sendMaxUsd: "9.80", from: "EUR", sendMax: "8.50" }),
    (e: unknown) => e instanceof XrplPathError && e.requote,
  );
  await assert.rejects(
    engine.settle({ paymentId: "pay_eur3", merchantAddress: merchant, local: money("12.50", "SGD"), sendMaxUsd: "9.80", from: "EUR" }),
    /sendMax \(quote.sendMax, in EUR\) is required/,
  );
  assert.equal(fake.submitted.length, 1);
});

test("engine.settle: 2-hop pair without a path_find answer uses the explicit hub path; same currency is a plain payment", async () => {
  const treasury = Wallet.generate();
  const merchant = Wallet.generate().address;
  const fake = fakeRippled({ pathFind: () => [] });
  const engine = fakeEngine(fake, treasury);
  await engine.settle({ paymentId: "pay_sgd_eur", merchantAddress: merchant, local: money("4.20", "EUR"), sendMaxUsd: "4.59", from: "SGD", sendMax: "5.92" });
  const hubTx = fake.submitted[0] as Record<string, unknown>;
  assert.deepEqual(hubTx.Paths, [[{ currency: RLUSD_HEX, issuer: A.usd }, { currency: "EUR", issuer: A.eur }]]);
  assert.deepEqual(hubTx.SendMax, { currency: XSGD_HEX, issuer: A.sgd, value: "5.92" });

  await engine.settle({ paymentId: "pay_usd_eur", merchantAddress: merchant, local: money("9.50", "EUR"), sendMaxUsd: "10.38", from: "USD" });
  const oneHop = fake.submitted[1] as Record<string, unknown>;
  assert.equal("Paths" in oneHop, false); // USD ↔ X is the default path through the single pool
  assert.deepEqual(oneHop.SendMax, { currency: RLUSD_HEX, issuer: A.usd, value: "10.38" });

  const before = fake.requests.filter((r) => r.command === "ripple_path_find").length;
  const r = await engine.settle({ paymentId: "pay_eur_eur", merchantAddress: merchant, local: money("3.00", "EUR"), sendMaxUsd: "0", from: "EUR" });
  assert.equal(r.delivered, "3.00");
  const direct = fake.submitted[2] as Record<string, unknown>;
  assert.deepEqual(direct.Amount, { currency: "EUR", issuer: A.eur, value: "3" });
  assert.equal("SendMax" in direct, false);
  assert.equal("Paths" in direct, false);
  assert.equal(fake.requests.filter((r2) => r2.command === "ripple_path_find").length, before); // no path finding
});

test("currency codes used on the ledger come from the registry", () => {
  assert.equal(currencyHex("RLUSD"), RLUSD_HEX);
  assert.equal(currencyHex("XSGD"), XSGD_HEX);
  assert.equal(currencyHex("EUR"), "EUR");
});
