// SERVER ONLY. Demo shop for /m/[merchantId] while GET /api/shops/:id returns 501 (NEXT_PUBLIC_DEMO_FIXTURES=1 only).
// @rove/shared/mocks pulls in node:crypto, so this is built in the server component and handed to the client as props.
import { ShopPublicRes } from "@rove/shared";
import { DEMO_MENU, DEMO_MERCHANT } from "@rove/shared/mocks";
import type { ShopView } from "./_types";

export const FIXTURES_ENABLED = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

/** The demo shop (`ahseng`), or null for any other shop code (→ "Shop not found"). */
export function fixtureShop(merchantId: string): ShopView | null {
  if (merchantId !== DEMO_MERCHANT.id) return null;
  const menu = DEMO_MENU.filter((m) => m.merchantId === DEMO_MERCHANT.id)
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map((m) => ({ id: m.id, name: m.name, price: m.price, active: m.active }));
  return ShopPublicRes.parse({ id: DEMO_MERCHANT.id, name: DEMO_MERCHANT.name, currency: DEMO_MERCHANT.currency, verified: true, menu });
}
