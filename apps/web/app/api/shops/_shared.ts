// Helpers shared by the read routes (NI-B4: invoices, shops, payments) and GET /api/me (NI-B5). Owner: Nithya.
// Lives here rather than in ../_lib (NI-C1's) so the tasks stay in their own paths; move it to _lib when convenient.
//
//   verified: settlement.isVerifiedMerchant(xrplAddress), cached 60s per merchant; engine down / slow / no address
//             → the DB flag (credentialStatus === "accepted"), not cached, so the next request asks XRPL again.
//   respond:  every response body is parsed by its zod schema before it goes out; a body that doesn't match is OUR
//             bug, so it becomes a 500 (route() would otherwise turn a ZodError into a 400 "invalid_body").

import type { Invoice, Merchant } from "@rove/shared";
import type { ZodTypeAny, z } from "zod";
import { json } from "../_lib/http";
import type { WebDeps } from "../_lib/deps";

export const VERIFIED_TTL_MS = 60_000;
/** isVerifiedMerchant is a ledger_entry lookup; a public page shouldn't wait on a slow XRPL node for a badge. */
export const VERIFIED_TIMEOUT_MS = 1_500;

const verifiedCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Tests only. */
export function clearVerifiedCache(): void {
  verifiedCache.clear();
}

export function withTimeout<T>(p: Promise<T>, ms: number, what = "call"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Verified badge: XRPL Credential ROVE_VERIFIED_MERCHANT accepted (engine), else the DB flag. Never throws. */
export async function merchantVerified(
  deps: Pick<WebDeps, "settlement">,
  merchant: Pick<Merchant, "id" | "xrplAddress" | "credentialStatus">,
  now: number = Date.now(),
): Promise<boolean> {
  const fallback = merchant.credentialStatus === "accepted";
  const address = merchant.xrplAddress;
  if (!address) return fallback;

  const key = `${merchant.id}:${address}`;
  const hit = verifiedCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    const value = await withTimeout(deps.settlement.isVerifiedMerchant(address), VERIFIED_TIMEOUT_MS, "isVerifiedMerchant");
    verifiedCache.set(key, { value, expiresAt: now + VERIFIED_TTL_MS });
    return value;
  } catch (err) {
    console.warn(`[api] isVerifiedMerchant(${merchant.id}) failed; using the DB credential flag:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Public invoice status: open + past expiresAt reads as expired even if the worker's expiry sweep hasn't run yet. */
export function publicInvoiceStatus(inv: Pick<Invoice, "status" | "expiresAt">, now: number = Date.now()): Invoice["status"] {
  return inv.status === "open" && Date.parse(inv.expiresAt) <= now ? "expired" : inv.status;
}

/** Validate an outgoing body against its contract schema, then send it (Cache-Control: no-store). */
export function respond<S extends ZodTypeAny>(schema: S, body: z.input<S>, init?: ResponseInit): Response {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Throwing a plain Error makes route() log it and answer 500 without leaking the body.
    throw new Error(`response failed its contract schema: ${JSON.stringify(parsed.error.issues).slice(0, 2000)}`);
  }
  return json(parsed.data, init);
}
