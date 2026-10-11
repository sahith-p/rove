// Worker service (port PORT || 4001). Owner: Nithya. Specs: docs/specs/settlement-xrpl.md, docs/specs/withdrawals.md
// Routes (all require `authorization: Bearer ${INTERNAL_SECRET}`; /healthz is public), schemas in @rove/shared api.ts:
//   POST  /internal/settle                         NI-C2  settle.ts
//   POST  /internal/refunds                        NI-C5  refunds.ts
//   POST  /internal/withdrawals                    NI-C3  withdrawals/create.ts (create `requested`, no money moves)
//   POST  /internal/withdrawals/:id/execute        NI-C4  withdrawals/execute.ts (the pipeline)
//   POST  /internal/merchants                      NI-C1  merchants.ts (createMerchantAccount → status live)
//   PATCH /internal/merchants/:id/auto-withdraw    NI-C4  withdrawals/auto.ts
// Background (jobs.ts): settle poller + invoice expiry (NI-C2), partner callbacks + nightly auto-withdraw (NI-C4),
//   BNB pay-in watcher (NI-C6), reconciler (NI-C7). Boot recovery (boot.ts, NI-C7): resume withdrawals, replay events.
// Emits EventEnvelope → POST ${AGENT_URL}/internal/events after every state change (emit.ts).
// Boot order: deps → HTTP server → background jobs → boot().

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { boot } from "./boot";
import { createDepsFromEnv } from "./deps";
import { startJobs } from "./jobs";
import { createServer } from "./server";

// Local dev: read the repo-root .env (existing env vars win; Railway sets them directly).
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  const deps = await createDepsFromEnv();
  const app = createServer(deps);
  const server = serve({ fetch: app.fetch, port: deps.config.port }, (info) => {
    deps.log.info(`listening on :${info.port}`);
  });
  const stopJobs = startJobs(deps);
  await boot(deps);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    deps.log.info(`${signal}: shutting down`);
    stopJobs();
    server.close(() => {
      deps.db
        .close()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("worker failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
