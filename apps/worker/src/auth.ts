// Service-to-service auth for /internal/*: `authorization: Bearer ${INTERNAL_SECRET}`. /healthz stays public.

import type { MiddlewareHandler } from "hono";
import { isInternalAuthorized } from "@rove/shared";

export function internalAuth(secret: string): MiddlewareHandler {
  return async (c, next) => {
    // An empty secret would accept "Bearer " from anyone, so it accepts nothing instead.
    if (!secret || !isInternalAuthorized(c.req.header("authorization"), secret)) {
      return c.json({ error: "unauthorized", message: "Missing or wrong internal bearer token." }, 401);
    }
    await next();
  };
}
