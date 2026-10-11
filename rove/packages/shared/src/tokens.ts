// Signed tokens for merchant pages (setup, bank, my shop, withdrawal, sale cards) and confirm buttons.
// HMAC-SHA256 over a base64url JSON body. Node runtime only (route handlers / server components, not edge middleware).
// Customer pages need no token: invoice codes and payment ids are unguessable.

import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function signToken<T extends { exp: number }>(payload: T, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T extends { exp: number }>(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  return payload.exp > nowSec ? payload : null;
}

/**
 * Merchant page session. `scope` limits what the page may do:
 *  setup → PUT /api/me/shop, /api/me/menu · bank → POST /api/me/bank-accounts (15-min expiry)
 *  shop → GET /api/me · withdrawal/sale → read one object (ref)
 */
export interface MerchantSessionPayload {
  merchantId: string;
  scope: "setup" | "bank" | "shop" | "withdrawal" | "sale";
  ref?: string;
  exp: number;
}

/** Confirm-button payload for a pending action. */
export interface ConfirmTokenPayload {
  actionId: string;
  merchantId: string;
  exp: number;
}

export const TOKEN_TTL_SEC = { setup: 24 * 3600, bank: 15 * 60, shop: 7 * 24 * 3600, withdrawal: 7 * 24 * 3600, sale: 7 * 24 * 3600, confirm: 5 * 60 } as const;
