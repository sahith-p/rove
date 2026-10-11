// SERVER ONLY (reads TOKEN_SECRET; Node runtime): server components and route handlers, never client components.
// The `server-only` package isn't a dependency of apps/web; if it gets added, put `import "server-only";` here.
//
// Usage in a merchant page (`/setup?t=…`):
//   const { t } = await searchParams;
//   const session = readSession(t, ["setup"]);
//   if (!session) return <Expired />;
//   return <SetupForm headers={sessionHeaders(t)} />;   // client fetches send x-rove-session
import { verifyToken, type MerchantSessionPayload } from "@rove/shared";

export { sessionHeaders } from "./headers";

export type SessionScope = MerchantSessionPayload["scope"];

/** The verified session, or null when `t` is missing, tampered with, expired, or not one of `scopes`. */
export function readSession(t: string | string[] | undefined, scopes: SessionScope[]): MerchantSessionPayload | null {
  const token = Array.isArray(t) ? t[0] : t;
  if (!token) return null;
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET is not set");
  let payload: MerchantSessionPayload | null;
  try {
    payload = verifyToken<MerchantSessionPayload>(token, secret);
  } catch {
    return null;
  }
  if (!payload || !scopes.includes(payload.scope)) return null;
  return payload;
}
