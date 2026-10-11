// Smoke test for POST /internal/merchants (NI-C1): onboarding gets a live merchant and merchant.live reaches the agent.
//
//   pnpm --filter worker exec tsx scripts/merchants-smoke.ts [merchantId] [phone]
//       → against a running worker (WORKER_URL, INTERNAL_SECRET from the env / repo-root .env). Calls twice; the second
//         call must return the same account (check the agent log for exactly one merchant.live).
//   pnpm --filter worker exec tsx scripts/merchants-smoke.ts --local
//       → no DB or agent needed: boots the real server + emitter on random ports with an in-memory fake DB, the mock
//         engine and a stand-in agent, and checks the event arrives once with the bearer token.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createMockPayoutPartner, createMockSettlement } from "@rove/shared/mocks";
import { createEmitter } from "../src/emit";
import { createLogger } from "../src/log";
import { createServer } from "../src/server";
import { createFakeDb } from "../src/test-fakes";
import { TEST_CONFIG } from "../src/testing";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = process.argv.slice(2);
const local = args.includes("--local");
const [merchantId = "smoke-shop", phone = "+15555550142"] = args.filter((a) => !a.startsWith("--"));
const body = { id: merchantId, name: "Smoke Test Kopi", phone, channel: "imessage", currency: "SGD", category: "cafe" };

async function call(workerUrl: string, secret: string) {
  const res = await fetch(`${workerUrl.replace(/\/$/, "")}/internal/merchants`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`POST /internal/merchants → ${res.status}`, json);
  assert.equal(res.status, 200);
  return json;
}

async function remote() {
  const workerUrl = process.env.WORKER_URL || "http://localhost:4001";
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) throw new Error("INTERNAL_SECRET is not set");
  const first = await call(workerUrl, secret);
  const second = await call(workerUrl, secret);
  assert.deepEqual(second, first, "second call returns the same account");
  console.log("✓ idempotent. The agent should have logged exactly one merchant.live for", merchantId);
}

async function inProcess() {
  const secret = "smoke-secret";
  const received: { auth?: string; body: { id: string; event: { type: string } } }[] = [];
  const agent = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => agent.listen(0, r));
  const agentUrl = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;

  const fake = createFakeDb();
  const log = createLogger("smoke");
  const config = { ...TEST_CONFIG, internalSecret: secret, agentUrl };
  const deps = {
    db: fake.db,
    settlement: createMockSettlement(),
    payouts: createMockPayoutPartner(),
    stripe: null,
    emit: createEmitter({ db: fake.db, agentUrl, secret, log: log.child("emit") }),
    config,
    log,
    now: () => new Date(),
  };
  const app = createServer(deps);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const workerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const first = await call(workerUrl, secret);
    const second = await call(workerUrl, secret);
    assert.deepEqual(second, first);
    assert.equal(received.length, 1, "exactly one event reached the agent");
    assert.equal(received[0]!.auth, `Bearer ${secret}`);
    assert.equal(received[0]!.body.event.type, "merchant.live");
    assert.ok(fake.delivered.has(received[0]!.body.id), "event marked delivered");
    console.log("✓ live merchant, one merchant.live delivered to the agent, second call idempotent");
  } finally {
    server.close();
    agent.close();
  }
}

(local ? inProcess() : remote()).catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
