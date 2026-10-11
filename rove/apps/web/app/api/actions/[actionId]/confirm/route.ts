// POST /api/actions/:actionId/confirm: verify ConfirmTokenPayload → agent /internal/actions/:id/confirm {via:"card"|"web"}
// Owner: Saran · Task: SA-A3 · Spec: docs/specs/agent.md · Schemas: @rove/shared api.ts
export async function POST(): Promise<Response> {
  return Response.json({ error: "not implemented: SA-A3" }, { status: 501 });
}
