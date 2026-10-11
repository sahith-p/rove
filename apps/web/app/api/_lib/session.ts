// Merchant page sessions for API routes: `x-rove-session: <signToken(MerchantSessionPayload)>` (pages get it from `?t=`).
// Owner: Nithya (NI-C1). Reads TOKEN_SECRET; Node runtime only.
//
//   const s = requireSession(req, ["setup"]);                            // PUT /api/me/menu
//   const s = requireSession(req, ["withdrawal", "shop"], { ref: id });  // GET /api/withdrawals/:id (+ check ownership)
//
// 401 missing_session / invalid_session / session_expired · 403 wrong_scope / wrong_ref (thrown as HttpError; route() maps it).

import { SESSION_HEADER, verifyToken, type MerchantSessionPayload } from "@rove/shared";
import { HttpError } from "./http";

export type SessionScope = MerchantSessionPayload["scope"];

/** Scopes that name one object: their `ref` must match `opts.ref`. Broader scopes (shop, setup, bank) carry no ref. */
const REF_SCOPES: ReadonlySet<SessionScope> = new Set(["withdrawal", "sale"]);

function tokenSecret(): string {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET is not set");
  return secret;
}

type Verified = { ok: true; payload: MerchantSessionPayload } | { ok: false; code: "missing_session" | "invalid_session" | "session_expired" };

function verify(req: Request, nowSec: number): Verified {
  const token = req.headers.get(SESSION_HEADER);
  if (!token) return { ok: false, code: "missing_session" };
  let payload: MerchantSessionPayload | null = null;
  try {
    // nowSec 0: check the signature only, then tell "expired" apart from "tampered".
    payload = verifyToken<MerchantSessionPayload>(token, tokenSecret(), 0);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_SECRET is not set") throw err;
    payload = null;
  }
  if (!payload || typeof payload.merchantId !== "string" || typeof payload.scope !== "string") return { ok: false, code: "invalid_session" };
  if (!(payload.exp > nowSec)) return { ok: false, code: "session_expired" };
  return { ok: true, payload };
}

const MESSAGES = {
  missing_session: "This page needs a link from Rove. Ask Rove for a new one.",
  invalid_session: "This link isn't valid. Ask Rove for a new one.",
  session_expired: "This link has expired. Ask Rove for a new one.",
} as const;

export function requireSession(
  req: Request,
  scopes: SessionScope[],
  opts: { ref?: string; nowSec?: number } = {},
): MerchantSessionPayload {
  const v = verify(req, opts.nowSec ?? Math.floor(Date.now() / 1000));
  if (!v.ok) throw new HttpError(401, v.code, MESSAGES[v.code]);
  const s = v.payload;
  if (!scopes.includes(s.scope)) throw new HttpError(403, "wrong_scope", "This link can't do that. Ask Rove for a new one.");
  if (opts.ref !== undefined && (REF_SCOPES.has(s.scope) || s.ref !== undefined) && s.ref !== opts.ref) {
    throw new HttpError(403, "wrong_ref", "This link is for something else. Ask Rove for a new one.");
  }
  return s;
}

/** The session if the request carries a valid, unexpired one (optionally limited to `scopes`), else null. Never throws for bad tokens. */
export function optionalSession(req: Request, scopes?: SessionScope[]): MerchantSessionPayload | null {
  const v = verify(req, Math.floor(Date.now() / 1000));
  if (!v.ok) return null;
  if (scopes && !scopes.includes(v.payload.scope)) return null;
  return v.payload;
}
