// POST /api/me/bank-accounts (bank scope): partner beneficiary, store id + last4 only → emits bank_account.added
// Owner: Nithya · Task: NI-B6 · Spec: docs/specs/withdrawals.md · Schemas: @rove/shared api.ts
export async function POST(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B6" }, { status: 501 });
}
