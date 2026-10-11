// GET /api/me (x-rove-session) → MeRes
// Owner: Nithya · Task: NI-B5 · Spec: docs/specs/web-app.md · Schemas: @rove/shared api.ts
export async function GET(): Promise<Response> {
  return Response.json({ error: "not implemented: NI-B5" }, { status: 501 });
}
