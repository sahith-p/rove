// POST /api/checkout: invoice code or fixed-QR target → quote + Stripe PaymentIntent (or BNB deposit address)
// Owner: Nithya · Task: NI-B2 · Spec: docs/specs/payments-stripe.md · Schemas: @rove/shared api.ts
export async function POST(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B2" }, { status: 501 });
}
