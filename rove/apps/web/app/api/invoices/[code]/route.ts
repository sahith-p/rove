// GET /api/invoices/:code → InvoicePublicRes
// Owner: Nithya · Task: NI-B4 · Spec: docs/specs/invoicing-and-qr.md · Schemas: @rove/shared api.ts
export async function GET(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B4" }, { status: 501 });
}
