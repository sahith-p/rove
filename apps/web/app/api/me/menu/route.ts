// PUT /api/me/menu (setup scope) UpdateMenuReq → replace the menu → 204, emits shop.updated ["menu"]
// Owner: Nithya · Task: NI-B5 · Spec: docs/specs/payments-stripe.md §5, docs/specs/web-app.md · Schemas: @rove/shared api.ts
// Prices are parsed with money() in the shop's currency (exact, 2 dp, > 0): never floats. Rows the merchant left out
// are deactivated by db.replaceMenu (old invoices still name them), not deleted.

import { DbConflictError, type MenuItemInput } from "@rove/db";
import { isPositive, money, UpdateMenuReq, type Money } from "@rove/shared";
import { getWebDeps } from "../../_lib/deps";
import { HttpError, noContent, readJson, route } from "../../_lib/http";
import { requireSession } from "../../_lib/session";
import { emitShopUpdated } from "../shop/_emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = route(async (req) => {
  const session = requireSession(req, ["setup"]);
  const body = await readJson(req, UpdateMenuReq);

  const deps = getWebDeps();
  const merchant = await deps.db.getMerchant(session.merchantId);
  if (!merchant) throw new HttpError(404, "merchant_not_found", "We couldn't find your shop. Text Rove for a new link.");

  const seen = new Set<string>();
  const items: MenuItemInput[] = body.items.map((it) => {
    const name = it.name.trim();
    if (!name) throw new HttpError(400, "invalid_item", "Every menu item needs a name.");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, "duplicate_item", `Two menu items are called "${name}". Rename one.`);
    seen.add(key);
    let price: Money;
    try {
      price = money(it.price, merchant.currency);
    } catch {
      throw new HttpError(400, "invalid_price", `The price of "${name}" can have at most 2 decimal places.`);
    }
    if (!isPositive(price)) throw new HttpError(400, "invalid_price", `The price of "${name}" must be more than zero.`);
    return { ...(it.id ? { id: it.id } : {}), name, price, active: it.active };
  });

  try {
    await deps.db.replaceMenu(merchant.id, items);
  } catch (err) {
    if (err instanceof DbConflictError || (err instanceof Error && err.name === "DbConflictError")) {
      throw new HttpError(409, "duplicate_item", "Two menu items have the same name. Rename one and save again.");
    }
    throw err;
  }

  await emitShopUpdated(deps, merchant.id, ["menu"]);
  return noContent();
});
