// SERVER ONLY. The request's own origin, so server code (metadata, OG image routes) can call our /api routes.
import { headers } from "next/headers";

export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/** `metadataBase` for a page, so og:image is absolute on whichever host served the card. */
export async function metadataBase(): Promise<URL | undefined> {
  try {
    return new URL(await requestOrigin());
  } catch {
    return undefined;
  }
}

/** GET one of our own JSON routes with a short timeout. Parsed JSON on 2xx, `{ status }` otherwise, null on failure. */
export async function getOwnJson(
  path: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ ok: true; json: unknown } | { ok: false; status: number | null }> {
  try {
    const res = await fetch(`${await requestOrigin()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 3500),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, status: null };
  }
}
