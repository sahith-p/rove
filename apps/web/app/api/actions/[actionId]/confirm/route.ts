// POST /api/actions/:actionId/confirm: verify ConfirmTokenPayload → agent /internal/actions/:id/confirm {via:"card"|"web"}
// Owner: Saran · Task: SA-A3 · Spec: docs/specs/agent.md · Schemas: @rove/shared api.ts
// The confirm card (/confirm) posts here with via=card; the withdrawal step-up page (/w) posts with ?via=web.

import { ConfirmActionReq, ConfirmActionRes, internalHeaders, ROUTES, verifyToken, type ConfirmTokenPayload } from "@rove/shared";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ actionId: string }> }): Promise<Response> {
  const { actionId } = await params;
  const parsed = ConfirmActionReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  const secret = process.env.TOKEN_SECRET ?? "";
  const payload = secret ? verifyToken<ConfirmTokenPayload>(parsed.data.token, secret) : null;
  if (!payload) return Response.json({ error: "invalid or expired token" }, { status: 401 });
  if (payload.actionId !== actionId) return Response.json({ error: "token is for a different action" }, { status: 403 });

  const via = new URL(req.url).searchParams.get("via") === "web" ? "web" : "card";
  const agentUrl = (process.env.AGENT_URL ?? "http://localhost:4002").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${agentUrl}${ROUTES.agent.confirm(actionId)}`, {
      method: "POST",
      headers: internalHeaders(process.env.INTERNAL_SECRET ?? ""),
      body: JSON.stringify({ via }),
    });
  } catch {
    return Response.json({ error: "agent unreachable" }, { status: 502 });
  }

  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const ok = ConfirmActionRes.safeParse(body);
    if (!ok.success) return Response.json({ error: "bad response from agent" }, { status: 502 });
    return Response.json(ok.data);
  }
  return Response.json(body ?? { error: "confirm failed" }, { status: res.status });
}
