// POST /api/stripe/webhook: verify signature (raw body), payment_intent.succeeded → authorized → worker /internal/settle
// Owner: Nithya · Task: NI-B3 · Spec: docs/specs/payments-stripe.md · Schemas: @rove/shared api.ts
export async function POST(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B3" }, { status: 501 });
}
