// SERVER ONLY. Loads the shop for the page and its metadata (deduped per request with React cache).
// GET /api/shops/:id → ShopPublicRes. 404 → not found. 501 / failure → demo fixtures when NEXT_PUBLIC_DEMO_FIXTURES=1.
import { headers } from "next/headers";
import { cache } from "react";
import { ROUTES, ShopPublicRes } from "@rove/shared";
import { FIXTURES_ENABLED, fixtureShop } from "./_fixtures";
import { SHOP_CODE_RE, type ShopView } from "./_types";

export type ShopLoad = { kind: "ok"; shop: ShopView; demo: boolean } | { kind: "not_found" } | { kind: "error" };

/** "AhSeng " → "ahseng". */
export function normalizeShopCode(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return s.trim().toLowerCase().slice(0, 48);
}

async function fetchShop(merchantId: string): Promise<{ ok: true; shop: ShopView } | { ok: false; status: number | null }> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return { ok: false, status: null };
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    const res = await fetch(`${proto}://${host}${ROUTES.shop(encodeURIComponent(merchantId))}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, status: res.status };
    const parsed = ShopPublicRes.safeParse(await res.json());
    return parsed.success ? { ok: true, shop: parsed.data } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
}

export const loadShop = cache(async (merchantId: string): Promise<ShopLoad> => {
  if (!SHOP_CODE_RE.test(merchantId)) return { kind: "not_found" };
  const res = await fetchShop(merchantId);
  if (res.ok) return { kind: "ok", shop: res.shop, demo: false };
  if (res.status === 404) return { kind: "not_found" };
  if (FIXTURES_ENABLED) {
    const shop = fixtureShop(merchantId);
    return shop ? { kind: "ok", shop, demo: true } : { kind: "not_found" };
  }
  return { kind: "error" };
});
