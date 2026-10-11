// quote() (NI-A3). Spec: settlement-xrpl.md §3.
// ripple_path_find from the treasury for the exact XSGD amount; fallback: constant-product math on amm_info.
// usd = source amount rounded UP to cents · sendMaxUsd = usd × 1.01 rounded up · rate = local / usd · valid 60s.
// All arithmetic is bigint (via @rove/shared money.ts), never floats.

import { fromMinor, fromUnits, toMinor, toUnits, type Money, type Quote } from "@rove/shared";
import type { Path } from "xrpl";
import type { EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { getAmm } from "./ledger";

export const QUOTE_TTL_MS = 60_000;
/** SendMax headroom over the quote, in percent. */
export const SLIPPAGE_PCT = 1n;
const RATE_DECIMALS = 4;
const AMM_SCALE = 15; // decimals for pool math

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Pure: a Quote for delivering `local` when the path costs `sourceUsdValue` RLUSD (any XRPL value format). */
export function buildQuote(local: Money, sourceUsdValue: string, now: number = Date.now()): Quote {
  if (local.currency !== "SGD") throw new Error(`quote: local must be SGD, got ${local.currency}`);
  const localCents = toMinor(local);
  if (localCents <= 0n) throw new Error("quote: amount must be positive");
  const source = plainDecimal(sourceUsdValue);
  if (source.startsWith("-")) throw new Error(`quote: negative source amount ${sourceUsdValue}`);
  const usdCents = toUnits(source, 2, "ceil");
  if (usdCents <= 0n) throw new Error(`quote: source amount rounds to zero (${sourceUsdValue})`);
  const sendMaxCents = ceilDiv(usdCents * (100n + SLIPPAGE_PCT), 100n);
  const rateUnits = (localCents * 10n ** BigInt(RATE_DECIMALS)) / usdCents; // both 2dp, so cents/cents = rate
  return {
    local: fromMinor(localCents, "SGD"),
    usd: fromMinor(usdCents, "USD"),
    rate: fromUnits(rateUnits, RATE_DECIMALS),
    sendMaxUsd: fromUnits(sendMaxCents, 2),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * Pure: RLUSD the AMM needs to pay out `out` XSGD (XLS-30 constant product, fee taken on the input):
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

export interface PathQuote {
  /** RLUSD the path needs (raw XRPL value). */
  sourceValue: string;
  paths: Path[];
}

/** ripple_path_find treasury → destination for exactly `local` XSGD, paid in RLUSD. null if no path. */
export async function findUsdToSgdPath(ctx: EngineContext, destination: string, local: Money): Promise<PathQuote | null> {
  const usd = ctx.usd();
  const sgd = ctx.sgd();
  const r = await ctx.conn.run((c) =>
    c.request({
      command: "ripple_path_find",
      source_account: ctx.treasuryAddress(),
      destination_account: destination,
      destination_amount: { currency: sgd.currency, issuer: sgd.issuer, value: local.amount },
      source_currencies: [{ currency: usd.currency, issuer: usd.issuer }],
    }),
  );
  let best: PathQuote | null = null;
  for (const alt of r.result.alternatives ?? []) {
    const src = alt.source_amount;
    if (typeof src === "string" || src.currency !== usd.currency || src.issuer !== usd.issuer) continue;
    const value = plainDecimal(src.value);
    if (!best || toUnits(value, AMM_SCALE, "ceil") < toUnits(plainDecimal(best.sourceValue), AMM_SCALE, "ceil")) {
      best = { sourceValue: src.value, paths: alt.paths_computed ?? [] };
    }
  }
  return best;
}

/** RLUSD needed per amm_info (fallback when path finding returns nothing or errors). */
export async function ammSourceValue(ctx: EngineContext, local: Money): Promise<string> {
  const amm = await getAmm(ctx.conn, ctx.usd(), ctx.sgd());
  if (!amm) throw new Error("quote: no RLUSD/XSGD AMM pool on this network (run `pnpm seed`)");
  return ammInputForOutput({ poolIn: amm.amount.value, poolOut: amm.amount2.value, out: local.amount, tradingFee: amm.tradingFee });
}

export async function quote(ctx: EngineContext, local: Money, now: () => number = Date.now): Promise<Quote> {
  // Config problems (missing issuer / treasury address) surface directly, not as a path-find fallback.
  ctx.usd();
  ctx.sgd();
  const treasury = ctx.treasuryAddress();
  let source: string | null = null;
  try {
    source = (await findUsdToSgdPath(ctx, treasury, local))?.sourceValue ?? null;
  } catch (err) {
    ctx.log(`quote: ripple_path_find failed (${err instanceof Error ? err.message : String(err)}); using amm_info`);
  }
  if (source === null) source = await ammSourceValue(ctx, local);
  return buildQuote(local, source, now());
}
