// POST /api/ausd/authorize: store the payer's signed ERC-3009 authorization for an `ausd` checkout (gasless AUSD on
// Base Sepolia; the worker relays it). Owner: Nithya · Spec: docs/specs/ausd-lane.md · AusdAuthorizeReq → PaymentStatusRes.
// Logic and error codes: ./authorize.ts.

import { AusdAuthorizeReq } from "@rove/shared";
import { getAusdDeps } from "../../_lib/ausd";
import { getWebDeps } from "../../_lib/deps";
import { readJson, route } from "../../_lib/http";
import { authorizeAusd } from "./authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const body = await readJson(req, AusdAuthorizeReq);
  return authorizeAusd(getWebDeps(), getAusdDeps(), body);
});
