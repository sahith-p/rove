// Client fetches for /pay/[code]. Relative URLs, every response validated with the @rove/shared schemas.
import { CheckoutReq, CheckoutRes, InvoicePublicRes, PaymentStatusRes, ROUTES, type Currency } from "@rove/shared";
import type { z } from "zod";
import type { CheckoutView, InvoiceView, PaymentView } from "./_fixtures";

/** `status` is the HTTP status, or null for a network error / a body that failed validation. */
export type Fetched<T> = { ok: true; data: T } | { ok: false; status: number | null };

async function call<S extends z.ZodTypeAny>(url: string, schema: S, init?: RequestInit): Promise<Fetched<z.infer<S>>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: { accept: "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: null };
  }
  if (!res.ok) return { ok: false, status: res.status };
  try {
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
}

export function getInvoice(code: string): Promise<Fetched<InvoiceView>> {
  return call(ROUTES.invoice(encodeURIComponent(code)), InvoicePublicRes);
}

export function getPayment(paymentId: string): Promise<Fetched<PaymentView>> {
  return call(ROUTES.payment(encodeURIComponent(paymentId)), PaymentStatusRes);
}

/** UI method → contract method. Apple Pay runs through Stripe's Express Checkout, so it is a "card" checkout. */
export type PayMethod = "apple_pay" | "card" | "bnb";

export function contractMethod(method: PayMethod): "card" | "bnb" {
  return method === "bnb" ? "bnb" : "card";
}

/** `payCurrency`: the payer is charged in their own currency so the card leg never converts (payments-stripe.md §1a). */
export function startCheckout(code: string, method: PayMethod, payCurrency: Currency): Promise<Fetched<CheckoutView>> {
  const body: z.infer<typeof CheckoutReq> = CheckoutReq.parse({
    target: { source: "invoice", code },
    method: contractMethod(method),
    payCurrency,
  });
  return call(ROUTES.checkout, CheckoutRes, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
