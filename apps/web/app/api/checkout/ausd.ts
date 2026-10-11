// method=ausd branch of POST /api/checkout (Agora AUSD on Base Sepolia, gasless for the payer; docs/specs/ausd-lane.md).
// Owner: Nithya · Filled in by the AUSD lane with the builder from ../_lib/ausd.ts. Until then it answers 501 so the
// pay page can hide or fall back from the AUSD button. Like bnb, an AUSD payer is always charged in USD (quote.usd).
// The target is already resolved and validated by checkout.ts.

import type { z } from "zod";
import type { CheckoutRes } from "@rove/shared";
import type { WebDeps } from "../_lib/deps";
import { HttpError } from "../_lib/http";
import type { CheckoutTarget } from "./target";

export async function checkoutAusd(_deps: WebDeps, _target: CheckoutTarget): Promise<z.infer<typeof CheckoutRes>> {
  throw new HttpError(501, "ausd_not_ready", "Paying with AUSD isn't available yet. Please pay by card.");
}
