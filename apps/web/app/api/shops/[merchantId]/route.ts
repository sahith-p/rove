// GET /api/shops/:merchantId → ShopPublicRes (name, verified, active menu)
// Owner: Nithya · Task: NI-B4 · Spec: docs/specs/payments-stripe.md §4 · Schemas: @rove/shared api.ts
// Public (no auth): the fixed-QR page /m/<merchantId>. Live shops only; a draft shop can't take money yet.

import { ShopPublicRes } from "@rove/shared";
import { getWebDeps } from "../../_lib/deps";
import { HttpError, route } from "../../_lib/http";
import { merchantVerified, respond } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ merchantId: string }> };

const NOT_FOUND = () => new HttpError(404, "shop_not_found", "This shop doesn't exist or isn't open yet.");

export const GET = route<Ctx>(async (_req, { params }) => {
  const { merchantId: raw } = await params;
  // Merchant ids are lowercase slugs (InternalCreateMerchantReq), so /m/AhSeng finds "ahseng".
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw NOT_FOUND();

  const deps = getWebDeps();
  const merchant = await deps.db.getMerchant(id);
  if (!merchant || merchant.status !== "live") throw NOT_FOUND();

  const [menu, verified] = await Promise.all([deps.db.listMenu(merchant.id), merchantVerified(deps, merchant)]);

  return respond(ShopPublicRes, {
    id: merchant.id,
    name: merchant.name,
    currency: merchant.currency,
    verified,
    // listMenu without includeInactive = active items only; filter again so a hidden item can never be offered.
    menu: menu.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, price: m.price, active: m.active })),
  });
});
