// Client fetch for the fixed-QR checkout. Polling and the method mapping are shared with /pay/[code].
import { CheckoutReq, CheckoutRes, ROUTES, type Currency } from "@rove/shared";
import type { z } from "zod";
import { contractMethod, type Fetched, type PayMethod } from "../../pay/[code]/_api";
import type { CheckoutView, Selection } from "./_types";

export { getPayment, contractMethod, type Fetched, type PayMethod } from "../../pay/[code]/_api";

/**
 * POST /api/checkout with `target.source = "fixed_qr"`. Items carry only ids + qty: the server prices them from the DB.
 * `payCurrency`: the payer is charged in their own currency so the card leg never converts (payments-stripe.md §1a).
 */
export async function startShopCheckout(
  merchantId: string,
  selection: Selection,
  method: PayMethod,
  payCurrency: Currency,
  payerPhone: string | null,
): Promise<Fetched<CheckoutView>> {
  const parsed = CheckoutReq.safeParse({
    target:
      selection.kind === "items"
        ? { source: "fixed_qr", merchantId, items: selection.items }
        : { source: "fixed_qr", merchantId, amount: selection.amount },
    method: contractMethod(method),
    payCurrency,
    ...(payerPhone ? { payerPhone } : {}),
  });
  if (!parsed.success) return { ok: false, status: 400 };
  const body: z.infer<typeof CheckoutReq> = parsed.data;

  let res: Response;
  try {
    res = await fetch(ROUTES.checkout, {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: null };
  }
  if (!res.ok) return { ok: false, status: res.status };
  try {
    const data = CheckoutRes.safeParse(await res.json());
    return data.success ? { ok: true, data: data.data } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
}
