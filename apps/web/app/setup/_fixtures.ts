// Demo fixtures for /setup (NEXT_PUBLIC_DEMO_FIXTURES=1 while GET /api/me is 501). Server-only: @rove/shared/mocks pulls
// in node:crypto, so the server page builds this and hands it to the client component as a prop.
import { DEMO_MENU, DEMO_MERCHANT } from "@rove/shared/mocks";
import type { SetupData } from "./model";

export function fixtureSetup(): SetupData {
  return {
    name: DEMO_MERCHANT.name,
    category: DEMO_MERCHANT.category,
    menu: [...DEMO_MENU]
      .sort((a, b) => a.sort - b.sort)
      .map((i) => ({ id: i.id, name: i.name, price: i.price.amount, active: i.active })),
  };
}
