// quote() (NI-A3, any corridor). Spec: settlement-xrpl.md §3, corridors.md §2.
// ripple_path_find from the treasury for the exact `local` amount, paid from the `from` float (default USD);
// fallback: constant-product math on amm_info along the hub route (from → RLUSD → local).
//   pay  = source amount rounded UP to the payer currency's minor unit · sendMax = pay × 1.01 rounded up
//   rate = local per 1 payer-currency unit (4 dp, floored) · valid 60s
//   usd / sendMaxUsd = the same for the USD route (always filled, so USD-only callers keep working)
// Same currency (from == local) is a direct payment: pay = local, sendMax = local, rate 1.
// All arithmetic is bigint (via @rove/shared money.ts), never floats.

import { DECIMALS, fromMinor, fromUnits, isCurrency, money, toMinor, toUnits, type Currency, type Money, type Quote } from "@rove/shared";
import type { Path } from "xrpl";
import type { Asset, EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { getAmm } from "./ledger";

export const QUOTE_TTL_MS = 60_000;
/** SendMax headroom over the quote, in percent. */
export const SLIPPAGE_PCT = 1n;
/** Every non-USD currency trades against RLUSD, so any pair is at most two AMM hops. */
export const HUB: Currency = "USD";
const RATE_DECIMALS = 4;
const AMM_SCALE = 15; // decimals for pool math

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const pow10 = (n: number) => 10n ** BigInt(n);

/** Pure: the currencies a settlement passes through. [from] = same currency (no swap); else via the RLUSD hub. */
export function routeFor(from: Currency, to: Currency): Currency[] {
  if (from === to) return [from];
  if (from === HUB || to === HUB) return [from, to];
  return [from, HUB, to];
}

/** Pure: `value` (any XRPL format) as Money in `currency`, rounded UP to its minor unit. Must be > 0. */
function ceilMoney(value: string, currency: Currency): Money {
  const v = plainDecimal(value);
  if (v.startsWith("-")) throw new Error(`quote: negative source amount ${value}`);
  const minor = toUnits(v, DECIMALS[currency], "ceil");
  if (minor <= 0n) throw new Error(`quote: source amount rounds to zero (${value})`);
  return fromMinor(minor, currency);
}

/** Pure: `m` + SLIPPAGE_PCT, rounded up to the minor unit. */
function withSlippage(m: Money): string {
  return fromUnits(ceilDiv(toMinor(m) * (100n + SLIPPAGE_PCT), 100n), DECIMALS[m.currency]);
}

/** Pure: local per 1 unit of `pay.currency`, floored at 4 decimals. */
function rateFor(local: Money, pay: Money): string {
  const dl = DECIMALS[local.currency];
  const dp = DECIMALS[pay.currency];
  return fromUnits((toMinor(local) * pow10(dp + RATE_DECIMALS)) / (toMinor(pay) * pow10(dl)), RATE_DECIMALS);
}

function positiveLocal(local: Money): Money {
  const m = money(local.amount, local.currency);
  if (toMinor(m) <= 0n) throw new Error("quote: amount must be positive");
  return m;
}

/** Pure: the original USD-route Quote for delivering `local` when the path costs `sourceUsdValue` RLUSD (any XRPL value
 *  format). Exactly the five original fields. `local` must not be USD (a USD → USD payment needs no swap). */
export function buildQuote(local: Money, sourceUsdValue: string, now: number = Date.now()): Quote {
  if (local.currency === "USD") throw new Error("quote: local is USD; a USD → USD payment needs no swap (use buildPairQuote)");
  const l = positiveLocal(local);
  const usd = ceilMoney(sourceUsdValue, "USD");
  return {
    local: l,
    usd,
    rate: rateFor(l, usd),
    sendMaxUsd: withSlippage(usd),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * Pure: a Quote for any pair. `sourceValue` = what the `from` route costs (raw XRPL value; ignored when from == local),
 * `usdValue` = what the USD route costs (ignored when from or local is USD). Fills pay/sendMax and usd/sendMaxUsd.
 */
export function buildPairQuote(input: { local: Money; from: Currency; sourceValue: string; usdValue: string; now?: number }): Quote {
  const local = positiveLocal(input.local);
  const now = input.now ?? Date.now();
  const same = input.from === local.currency;
  const pay = same ? local : ceilMoney(input.sourceValue, input.from);
  const sendMax = same ? pay.amount : withSlippage(pay);
  let usd: Money;
  let sendMaxUsd: string;
  if (input.from === "USD") {
    usd = pay;
    sendMaxUsd = sendMax;
  } else if (local.currency === "USD") {
    usd = local;
    sendMaxUsd = local.amount; // the USD route to a USD merchant is a direct payment
  } else {
    usd = ceilMoney(input.usdValue, "USD");
    sendMaxUsd = withSlippage(usd);
  }
  return {
    local,
    usd,
    rate: same ? fromUnits(pow10(RATE_DECIMALS), RATE_DECIMALS) : rateFor(local, pay),
    sendMaxUsd,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    pay,
    sendMax,
  };
}

/**
 * Pure: input the AMM needs to pay out `out` (XLS-30 constant product, fee taken on the input):
 *   in = X·out / ((Y − out)·(1 − fee)),  fee = tradingFee / 100,000.  Rounded up at 15 decimals.
 */
export function ammInputForOutput(input: { poolIn: string; poolOut: string; out: string; tradingFee: number }): string {
  const s = (v: string) => toUnits(plainDecimal(v), AMM_SCALE, "floor");
  const X = s(input.poolIn);
  const Y = s(input.poolOut);
  const O = toUnits(plainDecimal(input.out), AMM_SCALE, "ceil");
  if (O <= 0n) throw new Error("ammInputForOutput: out must be positive");
  if (O >= Y) throw new Error("ammInputForOutput: pool can't pay out that much");
  const fee = BigInt(input.tradingFee);
  const num = X * O * 100_000n;
  const den = (Y - O) * (100_000n - fee);
  return fromUnits(ceilDiv(num, den), AMM_SCALE);
}

export interface AmmLeg {
  /** Pool balance of the asset going in. */
  poolIn: string;
  /** Pool balance of the asset coming out. */
  poolOut: string;
  tradingFee: number;
}

/** Pure: input needed at the start of a chain of AMM legs (e.g. EUR→RLUSD, RLUSD→XSGD) to get `out` at the end. */
export function chainInputForOutput(legs: AmmLeg[], out: string): string {
  if (legs.length === 0) throw new Error("chainInputForOutput: no legs");
  let need = out;
  for (let i = legs.length - 1; i >= 0; i--) need = ammInputForOutput({ ...(legs[i] as AmmLeg), out: need });
  return need;
}

export interface PathQuote {
  /** Source amount the path needs (raw XRPL value, in the source token). */
  sourceValue: string;
  paths: Path[];
}

/** ripple_path_find treasury → destination for exactly `value` of `deliver`, paid in `source`. null if no path. */
export async function findPath(ctx: EngineContext, q: { destination: string; deliver: Asset; value: string; source: Asset }): Promise<PathQuote | null> {
  const r = await ctx.conn.run((c) =>
    c.request({
      command: "ripple_path_find",
      source_account: ctx.treasuryAddress(),
      destination_account: q.destination,
      destination_amount: { currency: q.deliver.currency, issuer: q.deliver.issuer, value: q.value },
      source_currencies: [{ currency: q.source.currency, issuer: q.source.issuer }],
    }),
  );
  let best: PathQuote | null = null;
  for (const alt of r.result.alternatives ?? []) {
    const src = alt.source_amount;
    if (typeof src === "string" || src.currency !== q.source.currency || src.issuer !== q.source.issuer) continue;
    const value = plainDecimal(src.value);
    if (!best || toUnits(value, AMM_SCALE, "ceil") < toUnits(plainDecimal(best.sourceValue), AMM_SCALE, "ceil")) {
      best = { sourceValue: src.value, paths: alt.paths_computed ?? [] };
    }
  }
  return best;
}

/** ripple_path_find for exactly `local` (merchant currency) paid from the `from` float. */
export function findRoute(ctx: EngineContext, destination: string, local: Money, from: Currency): Promise<PathQuote | null> {
  return findPath(ctx, { destination, deliver: ctx.asset(local.currency), value: local.amount, source: ctx.asset(from) });
}

/** ripple_path_find treasury → destination for exactly `local` XSGD, paid in RLUSD. null if no path. */
export function findUsdToSgdPath(ctx: EngineContext, destination: string, local: Money): Promise<PathQuote | null> {
  return findPath(ctx, { destination, deliver: ctx.sgd(), value: local.amount, source: ctx.usd() });
}

/** What the `from` float needs per amm_info along the hub route (fallback when path finding returns nothing or errors). */
export async function ammSourceValue(ctx: EngineContext, local: Money, from: Currency = "USD"): Promise<string> {
  const route = routeFor(from, local.currency);
  if (route.length === 1) return local.amount;
  const legs: AmmLeg[] = [];
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i] as Currency;
    const b = route[i + 1] as Currency;
    const amm = await getAmm(ctx.conn, ctx.asset(a), ctx.asset(b));
    if (!amm) throw new Error(`quote: no ${ctx.tokenName(a)}/${ctx.tokenName(b)} AMM pool on this network (run \`pnpm seed\`)`);
    legs.push({ poolIn: amm.amount.value, poolOut: amm.amount2.value, tradingFee: amm.tradingFee });
  }
  return chainInputForOutput(legs, local.amount);
}

/** Cost of delivering `local` from the `from` float: path_find first, amm_info math if that fails or finds nothing. */
async function routeCost(ctx: EngineContext, destination: string, local: Money, from: Currency): Promise<string> {
  if (from === local.currency) return local.amount;
  try {
    const found = await findRoute(ctx, destination, local, from);
    if (found) return found.sourceValue;
  } catch (err) {
    ctx.log(`quote: ripple_path_find ${from} → ${local.currency} failed (${err instanceof Error ? err.message : String(err)}); using amm_info`);
  }
  return ammSourceValue(ctx, local, from);
}

export async function quote(ctx: EngineContext, local: Money, from: Currency = "USD", now: () => number = Date.now): Promise<Quote> {
  if (!isCurrency(from)) throw new Error(`quote: unsupported payer currency ${String(from)}`);
  // Config problems (missing issuer / treasury address) surface directly, not as a path-find fallback.
  ctx.usd();
  ctx.asset(local.currency);
  ctx.asset(from);
  const treasury = ctx.treasuryAddress();
  const needUsdRoute = from !== "USD" && local.currency !== "USD";
  const [source, usdSource] = await Promise.all([
    routeCost(ctx, treasury, local, from),
    needUsdRoute ? routeCost(ctx, treasury, local, "USD") : Promise.resolve(null),
  ]);
  return buildPairQuote({ local, from, sourceValue: source, usdValue: usdSource ?? source, now: now() });
}
