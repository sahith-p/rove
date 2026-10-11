// PUT /api/me/menu (setup scope) → emits shop.updated
// Owner: Nithya · Task: NI-B5 · Spec: docs/specs/web-app.md · Schemas: @rove/shared api.ts
export async function PUT(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B5" }, { status: 501 });
}
