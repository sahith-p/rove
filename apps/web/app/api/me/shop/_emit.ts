// shop.updated for PUT /api/me/shop and PUT /api/me/menu (NI-B5). Owner: Nithya.
//
// emit() records the envelope and then POSTs it to the agent with retries (up to ~17s when the agent is down), so the
// routes hand it to Next's after(): the setup page gets its 204 right away and delivery finishes after the response
// (waitUntil on Vercel). Outside a Next request scope (tests, scripts) after() throws, so we just await it.

import { after } from "next/server";
import type { RoveEvent } from "@rove/shared";
import type { WebDeps } from "../../_lib/deps";

export type ShopField = Extract<RoveEvent, { type: "shop.updated" }>["fields"][number];

export async function emitShopUpdated(deps: Pick<WebDeps, "emit">, merchantId: string, fields: ShopField[]): Promise<void> {
  if (fields.length === 0) return;
  const send = () => deps.emit({ type: "shop.updated", merchantId, fields });
  try {
    after(send);
  } catch {
    await send(); // never rejects (emit swallows and logs its own failures)
  }
}
