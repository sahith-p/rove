// GET /api/shops/:merchantId → ShopPublicRes (name, verified, menu)
// Owner: Nithya · Task: NI-B4 · Spec: docs/specs/payments-stripe.md · Schemas: @rove/shared api.ts
export async function GET(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B4" }, { status: 501 });
}
