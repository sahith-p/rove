// Internal HTTP (Hono, :4002). Owner: Saran (SA-A2). Spec: docs/specs/agent.md §2, docs/02-contracts.md "Internal".
//   POST /internal/events                  EventEnvelope → 202 (deduped on envelope id)
//   POST /internal/actions/:id/confirm     InternalConfirmReq → InternalConfirmRes (same executor as 👍 / YES)
// Every /internal/* route needs `authorization: Bearer ${INTERNAL_SECRET}`.

import { serve } from "@hono/node-server";
import { EventEnvelopeZ, InternalConfirmReq, isInternalAuthorized } from "@rove/shared";
import { Hono } from "hono";
import type { ActionsService, Deps, EventsHandler } from "./ports";

export function createServerApp(deps: Deps, m: { events: EventsHandler; actions: ActionsService }): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/internal/*", async (c, next) => {
    if (!isInternalAuthorized(c.req.header("authorization"), deps.config.internalSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/internal/events", async (c) => {
    const parsed = EventEnvelopeZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid event", issues: parsed.error.issues }, 400);
    // Ack first, then work: handling sends several cards (picture render + Photon), which outlasts the worker's
    // 5 s emit timeout; the worker then marked the agent unreachable. handle() dedupes on the envelope id.
    void m.events.handle(parsed.data).catch((err) => deps.log("[server] event failed", parsed.data.event.type, err));
    return c.json({ status: "accepted" }, 202);
  });

  app.post("/internal/actions/:id/confirm", async (c) => {
    const parsed = InternalConfirmReq.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { action, summary, outcome } = await m.actions.confirm(c.req.param("id"), parsed.data.via);
    if (outcome === "not_found") return c.json({ error: "action not found" }, 404);
    const view = { action: { id: action.id, kind: action.kind, summary, status: action.status, expiresAt: action.expiresAt } };
    return c.json(view, outcome === "expired" ? 409 : 200);
  });

  app.onError((err, c) => {
    deps.log("[server] error", err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  return app;
}

export function startServer(deps: Deps, m: { events: EventsHandler; actions: ActionsService }): { close(): void } {
  const app = createServerApp(deps, m);
  const server = serve({ fetch: app.fetch, port: deps.config.port }, (info) => deps.log(`[server] listening on :${info.port}`));
  return { close: () => server.close() };
}
