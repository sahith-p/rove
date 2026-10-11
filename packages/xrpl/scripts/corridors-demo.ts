// pnpm --filter @rove/xrpl corridors:demo — any-to-any settlement on XRPL testnet (docs/specs/corridors.md §5).
// Each corridor is ONE treasury → merchant Payment: the payer currency's float in, the merchant's currency out, at the
// market rate through the RLUSD hub (or directly when the currencies match). No card FX anywhere.
//   a) EUR payer → ahseng (SGD):        EUR → RLUSD → XSGD   (2 hops, both AMMs)
//   b) USD payer → cafe-berlin (EUR):   RLUSD → EUR          (1 hop)
//   c) SGD payer → cafe-berlin (EUR):   XSGD → RLUSD → EUR   (2 hops, both AMMs)
//   d) EUR payer → cafe-berlin (EUR):   EUR → EUR            (same currency, no swap)
// For each: quote, settle, then re-read the validated tx and check meta.delivered_amount is exactly the local amount.
// Also prints the USD → SGD quote before and after, to show the deepened pools barely move.
// Loads .env.seed (run `pnpm seed` first; ROVE_DOTENV / ROVE_ENV_SEED point at other env files).

import { currencyInfo, fromUnits, money, newId, sub, toUnits, type Currency, type Money, type Quote } from "@rove/shared";
import type { TransactionMetadata } from "xrpl";
import { tokenBalance } from "../src/balance";
import { currencyFromHex, plainDecimal } from "../src/currency";
import { createXrplSettlement, explorerAccountUrl, xrplConfigFromEnv } from "../src/index";
import { findLine, getAmm, getTrustLines } from "../src/ledger";
import { deliveredMoney } from "../src/settle";
import { lookupTx } from "../src/submit";
import { ENV_SEED_PATH, loadScriptEnv, testnetWss } from "./_env";

interface Corridor {
  name: string;
  merchantId: string;
  merchantAddress: string;
  local: Money;
  from: Currency;
}

const fmt = (m: Money) => `${currencyInfo(m.currency).symbol}${m.amount}`;

/** AMM accounts whose trust lines the tx changed (i.e. pools the payment swapped through). */
function ammsTouched(meta: TransactionMetadata, amms: Record<string, string>): string[] {
  const hit = new Set<string>();
  for (const n of meta.AffectedNodes as unknown as Record<string, { LedgerEntryType?: string; FinalFields?: Record<string, unknown>; NewFields?: Record<string, unknown> }>[]) {
    const node = n.ModifiedNode ?? n.CreatedNode ?? n.DeletedNode;
    if (!node || node.LedgerEntryType !== "RippleState") continue;
    const f = node.FinalFields ?? node.NewFields ?? {};
    const ends = [(f.HighLimit as { issuer?: string } | undefined)?.issuer, (f.LowLimit as { issuer?: string } | undefined)?.issuer];
    for (const [label, account] of Object.entries(amms)) if (ends.includes(account)) hit.add(label);
  }
  return [...hit];
}

function describePaths(paths: unknown): string {
  if (!Array.isArray(paths) || paths.length === 0) return "default path";
  return paths.map((p: { currency?: string }[]) => p.map((s) => (s.currency ? currencyFromHex(s.currency) : "?")).join(" → ")).join(" | ");
}

function quoteLine(q: Quote, from: Currency): string {
  const pay = q.pay ?? q.usd;
  const local = q.local;
  return `${fmt(pay)} (SendMax ${fmt(money(q.sendMax ?? q.sendMaxUsd, from))}) → ${fmt(local)} at ${q.rate} ${local.currency}/${from} · USD value US$${q.usd.amount}`;
}

async function main() {
  loadScriptEnv();
  testnetWss();
  const ahseng = process.env.DEMO_MERCHANT_XRPL_ADDRESS;
  const cafe = process.env.XRPL_MERCHANT_CAFE_BERLIN_ADDRESS;
  if (!ahseng || !cafe) throw new Error(`DEMO_MERCHANT_XRPL_ADDRESS / XRPL_MERCHANT_CAFE_BERLIN_ADDRESS missing: run \`pnpm seed\` (expects ${ENV_SEED_PATH})`);

  const txs: { label: string; hash: string }[] = [];
  const engine = createXrplSettlement(xrplConfigFromEnv(), { log: () => undefined, onTx: (label, o) => txs.push({ label, hash: o.hash }) });
  const ctx = engine.context;
  const treasury = ctx.treasuryAddress();
  /** Exact trust-line balance (not floored to cents), so "spent" shows what the swap really cost. */
  const rawBalance = async (address: string, c: Currency): Promise<bigint> => {
    const a = ctx.asset(c);
    const line = findLine(await getTrustLines(ctx.conn, address, a.issuer), a.currency, a.issuer);
    const v = line ? plainDecimal(line.balance) : "0";
    return v.startsWith("-") ? 0n : toUnits(v, 15, "floor");
  };
  const amms: Record<string, string> = {};
  for (const c of ["SGD", "EUR"] as Currency[]) {
    const pool = await getAmm(ctx.conn, ctx.usd(), ctx.asset(c));
    if (!pool) throw new Error(`no RLUSD/${ctx.tokenName(c)} pool: run \`pnpm seed\``);
    amms[`RLUSD/${ctx.tokenName(c)}`] = pool.account;
    console.log(`pool RLUSD/${ctx.tokenName(c)}: ${plainDecimal(pool.amount.value)} RLUSD / ${plainDecimal(pool.amount2.value)} ${ctx.tokenName(c)}  ${explorerAccountUrl(pool.account)}`);
  }

  const corridors: Corridor[] = [
    { name: "a) EUR payer → ahseng (SGD)", merchantId: "ahseng", merchantAddress: ahseng, local: money("12.50", "SGD"), from: "EUR" },
    { name: "b) USD payer → cafe-berlin (EUR)", merchantId: "cafe-berlin", merchantAddress: cafe, local: money("9.50", "EUR"), from: "USD" },
    { name: "c) SGD payer → cafe-berlin (EUR)", merchantId: "cafe-berlin", merchantAddress: cafe, local: money("4.20", "EUR"), from: "SGD" },
    { name: "d) EUR payer → cafe-berlin (EUR)", merchantId: "cafe-berlin", merchantAddress: cafe, local: money("3.00", "EUR"), from: "EUR" },
  ];

  const drift0 = await engine.quote({ local: money("12.50", "SGD") });
  console.log(`\nUSD → SGD reference quote before: ${quoteLine(drift0, "USD")}`);

  const results: { name: string; ok: boolean; hash: string; delivered: string; spent: string; route: string }[] = [];
  let failed = false;
  try {
    for (const c of corridors) {
      console.log(`\n${c.name}`);
      const merchantBefore = await tokenBalance(ctx, c.merchantAddress, c.local.currency);
      const floatBefore = await rawBalance(treasury, c.from);

      const q = await engine.quote({ local: c.local, from: c.from });
      console.log(`   quote   ${quoteLine(q, c.from)}`);

      const paymentId = newId("pay");
      const res = await engine.settle({
        paymentId,
        merchantAddress: c.merchantAddress,
        local: c.local,
        sendMaxUsd: q.sendMaxUsd,
        from: c.from,
        sendMax: q.sendMax,
      });

      // Independent check: re-read the validated tx, credit only meta.delivered_amount.
      const tx = await lookupTx(ctx.conn, res.txHash);
      if (!tx) throw new Error(`tx ${res.txHash} not found after settle`);
      const delivered = deliveredMoney(tx.meta, ctx.asset(c.local.currency), c.local.currency);
      const touched = ammsTouched(tx.meta, amms);
      const sendMax = tx.tx.SendMax as { currency: string; value: string } | undefined;
      const merchantAfter = await tokenBalance(ctx, c.merchantAddress, c.local.currency);
      const floatAfter = await rawBalance(treasury, c.from);
      const spent = { amount: fromUnits(floatBefore - floatAfter, 15).replace(/0+$/, "").replace(/\.$/, "") };
      const exact = delivered.amount === c.local.amount && res.delivered === c.local.amount;
      const credited = sub(merchantAfter, merchantBefore);

      console.log(`   settle  ${paymentId} → ${c.merchantId} ${c.merchantAddress}`);
      console.log(
        `   tx      ONE Payment · SendMax ${sendMax ? `${plainDecimal(sendMax.value)} ${currencyFromHex(sendMax.currency)}` : "none (same currency)"} · Paths: ${describePaths(tx.tx.Paths)} · pools used: ${touched.length ? touched.join(" + ") : "none"}`,
      );
      console.log(`   result  delivered_amount ${delivered.amount} ${ctx.tokenName(c.local.currency)} (${exact ? "exact" : "NOT EXACT"}) · treasury ${ctx.tokenName(c.from)} float −${spent.amount} · merchant +${credited.amount}${credited.amount === c.local.amount ? "" : " (balance also moved by other activity)"}`);
      console.log(`   ${engine.explorerUrl(res.txHash)}`);
      const route = c.from === c.local.currency ? "direct" : touched.join(" + ");
      if (!exact) failed = true;
      if (c.from !== c.local.currency && c.from !== "USD" && c.local.currency !== "USD" && touched.length !== 2) {
        console.log("   CHECK FAILED: a 2-hop corridor should swap through both pools");
        failed = true;
      }
      results.push({ name: c.name, ok: exact, hash: res.txHash, delivered: `${delivered.amount} ${ctx.tokenName(c.local.currency)}`, spent: `${spent.amount} ${ctx.tokenName(c.from)}`, route });
    }

    const drift1 = await engine.quote({ local: money("12.50", "SGD") });
    console.log(`\nUSD → SGD reference quote after:  ${quoteLine(drift1, "USD")}`);

    console.log("\nSummary");
    for (const r of results) {
      console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(36)} delivered ${r.delivered.padEnd(12)} spent ${r.spent.padEnd(14)} via ${r.route}`);
      console.log(`         ${engine.explorerUrl(r.hash)}`);
    }
    console.log(failed ? "\ncorridors:demo FAIL" : "\ncorridors:demo PASS: every corridor delivered exactly the local amount in one Payment");
    if (failed) process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error("corridors:demo failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
