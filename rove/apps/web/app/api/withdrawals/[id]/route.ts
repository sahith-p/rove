// GET /api/withdrawals/:id (withdrawal scope) → WithdrawalRes
// Owner: Nithya · Task: NI-B6 · Spec: docs/specs/withdrawals.md · Schemas: @rove/shared api.ts
export async function GET(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B6" }, { status: 501 });
}
