// Client-safe: the header merchant pages send on their API fetches. Import this (not ./session) from client components.
// Type-only import on purpose: the @rove/shared index also re-exports tokens.ts (node:crypto), which a client bundle
// can't load. `typeof SESSION_HEADER` still fails typecheck if the contract's header name ever changes.
import type { SESSION_HEADER } from "@rove/shared";

const HEADER: typeof SESSION_HEADER = "x-rove-session";

/** `fetch(url, { headers: sessionHeaders(t) })` → `{ "x-rove-session": t }`. */
export function sessionHeaders(t: string): Record<string, string> {
  return { [HEADER]: t };
}
