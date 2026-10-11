// balance() (NI-A5): the merchant's trust-line balance in their currency's stablecoin, the source of truth for funds
// (withdrawals.md §1). Read-only. The reconciler compares it to ledger available + held.

import { DECIMALS, fromMinor, toUnits, zero, type Currency, type Money } from "@rove/shared";
import type { EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { findLine, getTrustLines } from "./ledger";

/** `currency`'s stablecoin held by `address` (any account). No line / no account = 0. Dust below the minor unit is floored. */
export async function tokenBalance(ctx: EngineContext, address: string, currency: Currency): Promise<Money> {
  const asset = ctx.asset(currency);
  const line = findLine(await getTrustLines(ctx.conn, address, asset.issuer), asset.currency, asset.issuer);
  if (!line) return zero(currency);
  const v = plainDecimal(line.balance);
  if (v.startsWith("-")) return zero(currency); // only the issuer's side is negative
  return fromMinor(toUnits(v, DECIMALS[currency], "floor"), currency);
}

/** XSGD held by `address` (any account), as SGD Money. No line / no account = S$0.00. Sub-cent dust is floored. */
export function xsgdBalance(ctx: EngineContext, address: string): Promise<Money> {
  return tokenBalance(ctx, address, "SGD");
}
