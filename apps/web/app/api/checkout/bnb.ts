// method=bnb branch of POST /api/checkout. Owner: Nithya · Task: NI-C6 fills this in (docs/specs/bnb-lane.md,
// payments-stripe.md §1 step 7). Until then it answers 501 so the pay page can hide or fall back from the wallet option.
//
// What NI-C6 adds here (the target is already resolved and validated by checkout.ts):
//   quote = await deps.settlement.quote({ local: target.local }); charge = quote.usd (a BNB payer is always a USD payer)
//   index = await deps.db.nextDepositIndex() → HD deposit address
//   deps.db.insertPayment({ ..., method: "bnb", charge, bnbDepositAddress })
//   → { paymentId, local, quote, charge, bnb: { chainId: 97, depositAddress, token, decimals, amount: quote.usd.amount } }

import type { z } from "zod";
import type { CheckoutRes } from "@rove/shared";
import type { WebDeps } from "../_lib/deps";
import { HttpError } from "../_lib/http";
import type { CheckoutTarget } from "./target";

export async function checkoutBnb(_deps: WebDeps, _target: CheckoutTarget): Promise<z.infer<typeof CheckoutRes>> {
  throw new HttpError(501, "bnb_not_ready", "Paying from a crypto wallet isn't available yet. Please pay by card.");
}
