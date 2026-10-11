// PUT /api/me/shop (setup scope) UpdateShopReq → 204, emits shop.updated with the fields that actually changed
// Owner: Nithya · Task: NI-B5 · Spec: docs/specs/payments-stripe.md §5, docs/specs/web-app.md · Schemas: @rove/shared api.ts
// The setup page sends name + category + currency on every save; only real changes reach the agent.

import { UpdateShopReq, type Merchant } from "@rove/shared";
import { getWebDeps } from "../../_lib/deps";
import { HttpError, noContent, readJson, route } from "../../_lib/http";
import { requireSession } from "../../_lib/session";
import { emitShopUpdated, type ShopField } from "./_emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = route(async (req) => {
  const session = requireSession(req, ["setup"]);
  const body = await readJson(req, UpdateShopReq);

  const patch: { name?: string; category?: string | null; currency?: Merchant["currency"] } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length < 2) throw new HttpError(400, "invalid_name", "Shop name needs at least 2 characters.");
    patch.name = name;
  }
  if (body.category !== undefined) patch.category = body.category.trim() || null;
  if (body.currency !== undefined) patch.currency = body.currency;

  const deps = getWebDeps();
  const before = await deps.db.getMerchant(session.merchantId);
  if (!before) throw new HttpError(404, "merchant_not_found", "We couldn't find your shop. Text Rove for a new link.");
  const after = await deps.db.updateShop(before.id, patch);
  if (!after) throw new HttpError(404, "merchant_not_found", "We couldn't find your shop. Text Rove for a new link.");

  const fields = (["name", "category", "currency"] as const satisfies readonly ShopField[]).filter((f) => before[f] !== after[f]);
  await emitShopUpdated(deps, after.id, fields);
  return noContent();
});
