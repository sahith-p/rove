// balance() (NI-A5): the merchant's XSGD trust-line balance, the source of truth for funds (withdrawals.md §1).
// Read-only. The reconciler compares it to ledger available + held.

import { fromMinor, toUnits, zero, type Money } from "@rove/shared";
import type { EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { findLine, getTrustLines } from "./ledger";

/** XSGD held by `address` (any account), as SGD Money. No line / no account = S$0.00. Sub-cent dust is floored. */
export async function xsgdBalance(ctx: EngineContext, address: string): Promise<Money> {
  const sgd = ctx.sgd();
  const line = findLine(await getTrustLines(ctx.conn, address, sgd.issuer), sgd.currency, sgd.issuer);
  if (!line) return zero("SGD");
  const v = plainDecimal(line.balance);
  if (v.startsWith("-")) return zero("SGD"); // only the issuer's side is negative
  return fromMinor(toUnits(v, 2, "floor"), "SGD");
}
