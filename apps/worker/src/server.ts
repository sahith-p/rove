// HTTP surface of the worker: every internal route in @rove/shared ROUTES.worker, validated with the contract's zod
// schemas, delegating to one handler module each. Owner: Nithya (NI-C1). Handlers own their logic; this file only
// parses, authorizes and maps errors:
//   bad JSON / body          → 400 { error: "invalid_json" | "invalid_body", message, issues? }
//   UserFacingError          → its status (default 422) { error: code, message }   (the agent can say `message`)
//   anything else            → 500 { error: "internal", message } + log

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  InternalCreateMerchantReq,
  InternalCreateWithdrawalReq,
  InternalExecuteWithdrawalReq,
  InternalRefundReq,
  InternalSetAutoWithdrawReq,
  InternalSettleReq,
  ROUTES,
} from "@rove/shared";
import { internalAuth } from "./auth";
import type { WorkerDeps } from "./deps";
import { isUserFacingError } from "./errors";
import { createMerchant } from "./merchants";
import { reconcileSnapshot } from "./reconcile";
import { handleRefund } from "./refunds";
import { handleSettle } from "./settle";
import { setAutoWithdraw } from "./withdrawals/auto";
import { createWithdrawal } from "./withdrawals/create";
import { executeWithdrawal } from "./withdrawals/execute";

/** The bit of a zod schema this file needs (the worker has no direct zod dependency). */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

class BadRequest extends Error {
  constructor(
    readonly code: "invalid_json" | "invalid_body",
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
  }
}

async function body<T>(c: Context, schema: Schema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequest("invalid_json", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest("invalid_body", "Request body failed validation.", parsed.error.issues);
  return parsed.data;
}

/** `/internal/withdrawals/:id/execute` from the contract's path builder, so the two can't drift. */
const pattern = (build: (param: string) => string, param: string) => build(`:${param}`);

/** /healthz DB probe: answer from a recent check so a public endpoint can't be used to hammer the database. */
const DB_PROBE_TTL_MS = 5000;
const DB_PROBE_TIMEOUT_MS = 2000;

function dbProbe(deps: WorkerDeps, log: { warn(msg: string, f?: Record<string, unknown>): void }) {
  let last: { at: number; ok: boolean; ms: number } | null = null;
  let inFlight: Promise<{ ok: boolean; ms: number }> | null = null;
  const run = async () => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Cheapest real query the Db contract offers: a primary-key lookup that finds nothing.
      await Promise.race([
        deps.db.getMerchant("__healthz__"),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${DB_PROBE_TIMEOUT_MS}ms`)), DB_PROBE_TIMEOUT_MS))),
      ]);
      return { ok: true, ms: Date.now() - started };
    } catch (err) {
      log.warn("healthz: database unreachable", { err: err instanceof Error ? err.message : String(err) });
      return { ok: false, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
  return async () => {
    if (last && Date.now() - last.at < DB_PROBE_TTL_MS) return last;
    inFlight ??= run().finally(() => (inFlight = null));
    const r = await inFlight;
    last = { at: Date.now(), ...r };
    return last;
  };
}

export function createServer(deps: WorkerDeps): Hono {
  const app = new Hono();
  const log = deps.log.child("http");
  const W = ROUTES.worker;

  // Public (Railway's healthcheck): 200 when the worker can reach its database, else 503. No secrets, no hostnames.
  const probe = dbProbe(deps, log);
  app.get("/healthz", async (c) => {
    const db = await probe();
    const mock = deps.config.useMockSettlement;
    return c.json(
      {
        ok: db.ok,
        engine: mock ? "mock" : "real",
        settlement: mock ? "mock" : "xrpl",
        payouts: deps.config.useMockPayouts ? "mock" : "real",
        db: db.ok ? "ok" : "unreachable",
        dbMs: db.ms,
      },
      db.ok ? 200 : 503,
    );
  });

  app.use("/internal/*", internalAuth(deps.config.internalSecret));

  // NI-C7 · the reconciler's last result per merchant (ledger available + held vs XRPL). Read-only: no check runs here.
  app.get("/internal/reconcile", (c) => c.json(reconcileSnapshot(deps)));

  // NI-C2 · 202: settlement continues in the background (the poller covers lost nudges).
  app.post(W.settle, async (c) => {
    await handleSettle(deps, await body(c, InternalSettleReq));
    return c.json({ accepted: true }, 202);
  });

  // NI-C5
  app.post(W.refunds, async (c) => c.json(await handleRefund(deps, await body(c, InternalRefundReq)), 200));

  // NI-C3 · creates `requested`; no money moves.
  app.post(W.withdrawals, async (c) => c.json(await createWithdrawal(deps, await body(c, InternalCreateWithdrawalReq)), 200));

  // NI-C4 · 202: the pipeline runs on after the synchronous approve step.
  app.post(pattern(W.executeWithdrawal, "id"), async (c) => {
    await executeWithdrawal(deps, c.req.param("id")!, await body(c, InternalExecuteWithdrawalReq));
    return c.json({ accepted: true }, 202);
  });

  // NI-C1
  app.post(W.merchants, async (c) => c.json(await createMerchant(deps, await body(c, InternalCreateMerchantReq)), 200));

  // NI-C4
  app.patch(pattern(W.autoWithdraw, "id"), async (c) => {
    await setAutoWithdraw(deps, c.req.param("id")!, await body(c, InternalSetAutoWithdrawReq));
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: "not_found", message: `No route ${c.req.method} ${c.req.path}` }, 404));

  app.onError((err, c) => {
    if (err instanceof BadRequest) {
      return c.json({ error: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) }, 400);
    }
    if (isUserFacingError(err)) {
      // 501 stubs and merchant-readable refusals: expected, so no stack trace.
      log.info("refused", { route: `${c.req.method} ${c.req.path}`, code: err.code, status: err.status });
      return c.json({ error: err.code, message: err.message }, err.status as ContentfulStatusCode);
    }
    log.error("handler crashed", { route: `${c.req.method} ${c.req.path}`, err });
    return c.json({ error: "internal", message: "Something went wrong on our side." }, 500);
  });

  return app;
}
