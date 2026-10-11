// HTTP helpers for Nithya's route handlers (apps/web/app/api/**). Owner: Nithya (NI-C1). Node runtime only.
//
//   export const runtime = "nodejs";
//   export const POST = route(async (req) => {
//     const body = await readJson(req, CheckoutReq);          // bad JSON / ZodError → 400
//     if (!invoice) throw new HttpError(404, "invoice_not_found", "This payment link doesn't exist.");
//     return json(res);                                        // Cache-Control: no-store
//   });
//
// Error bodies are always { error: code, message } (+ issues for 400 validation errors). Pages may show `message`.

import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** JSON response with `Cache-Control: no-store` (unless the caller set its own). */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

/** 204 with no-store. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function errorJson(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, { status });
}

/** Parse the body as JSON and validate it. Invalid JSON → HttpError 400 invalid_json; schema errors → ZodError (→ 400). */
export async function readJson<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON.");
  }
  return schema.parse(raw);
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === "ZodError" && Array.isArray((err as ZodError).issues));
}

/** Wraps a route handler: ZodError → 400, HttpError → its status, anything else → 500 + log (no request body logged). */
export function route<C = unknown>(handler: (req: Request, ctx: C) => Promise<Response> | Response) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return errorJson(err.status, err.code, err.message);
      if (isZodError(err)) return errorJson(400, "invalid_body", "Request failed validation.", { issues: err.issues });
      let path = req.url;
      try {
        path = new URL(req.url).pathname;
      } catch {}
      console.error(`[api] ${req.method} ${path} crashed:`, err instanceof Error ? (err.stack ?? err.message) : err);
      return errorJson(500, "internal", "Something went wrong on our side. Please try again.");
    }
  };
}
