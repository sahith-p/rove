// Integration harness: the agent and Nithya's REAL worker in one process, sharing one in-process Postgres (PGlite via
// @rove/db/testing), each behind its own HTTP server on an ephemeral port, calling each other over HTTP like in
// production (agent → worker internal routes; worker → agent /internal/events). Nothing here touches Supabase,
// Photon, Stripe or XRPL: the worker runs on its fast test engine, mock payout partner and fake Stripe.
// Not a test file itself (the runner only picks up *.test.ts).

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createTestDb } from "@rove/db/testing";
import type { Db } from "@rove/db";
import { internalHeaders, money, type EventEnvelope, type Merchant, type Recipient } from "@rove/shared";
import { DEMO_CUSTOMER, DEMO_MERCHANT } from "@rove/shared/mocks";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { buildAgent, type Agent } from "../../src/app";
import { config as baseConfig } from "../../src/env";
import { handleInbound } from "../../src/inbound";
import { createConsoleOutbox, type RecordedSend } from "../../src/outbox";
import type { Inbound, WorkerClient } from "../../src/ports";
import { createServerApp } from "../../src/server";
import { createDbStore } from "../../src/store/db";
import { customerTools } from "../../src/tools/customer";
import { merchantTools } from "../../src/tools/merchant";
import { createHttpWorker } from "../../src/worker";

import { createEmitter } from "../../../worker/src/emit";
import { createLogger } from "../../../worker/src/log";
import { createServer as createWorkerServer } from "../../../worker/src/server";
import { createFakeStripe, type FakeStripe } from "../../../worker/src/settle/testkit";
import { startPartnerCallbacks } from "../../../worker/src/withdrawals/partner";
import { createCountingPartner, createFastEngine, type FastEngine } from "../../../worker/src/withdrawals/testkit";
import { createTestDeps, TEST_CONFIG, TEST_INTERNAL_SECRET, type TestDeps } from "../../../worker/src/testing";

export const MERCHANT: Recipient = { phone: DEMO_MERCHANT.phone, channel: "imessage" };
export const MAYA: Recipient = { phone: DEMO_CUSTOMER.phone, channel: "imessage" };
export const MERCHANT_ADDRESS = "rTESTAHSENGxxxxxxxxxxxxxxxxxxx";

type Server = ReturnType<typeof serve>;

function listen(fetch: (req: Request) => Response | Promise<Response>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
  });
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

export interface AgentHandle {
  agent: Agent;
  sends: RecordedSend[];
  replies: string[];
  /** Agent-side worker calls (method → count), counted at the HTTP client. */
  workerCalls: Map<string, number>;
}

export interface World extends AgentHandle {
  db: Db;
  worker: TestDeps;
  fast: FastEngine;
  stripe: FakeStripe;
  agentUrl: string;
  workerUrl: string;
  /** Every envelope the worker delivered to the agent, in order. */
  envelopes: EventEnvelope[];
  /** POSTs an envelope to the agent again, like the worker's retry / boot replay. */
  redeliver(envelope: EventEnvelope): Promise<{ status: number; body: unknown }>;
  /** Moves the worker's clock (e.g. past the 24h new-bank step-up window). */
  setWorkerClockOffset(ms: number): void;
  /** Builds another agent process on the same DB + worker (an agent restart). It replaces the one behind agentUrl. */
  restartAgent(opts?: { now?: () => Date }): AgentHandle;
  merchant(): Promise<Merchant>;
  /** Ledger payment_credit + the same XSGD on the fake chain (a settled sale, without events). */
  seedBalance(amount: string): Promise<void>;
  addBank(): Promise<string>;
  close(): Promise<void>;
}

export async function createWorld(opts: { agentNow?: () => Date } = {}): Promise<World> {
  const db = await createTestDb({ demo: true });
  await db.setMerchantXrpl(DEMO_MERCHANT.id, { xrplAddress: MERCHANT_ADDRESS, xrplSeedEnc: "enc:test", credentialStatus: "accepted" });

  // Agent HTTP server first (its handler is swapped in once the agent exists), so the worker knows AGENT_URL.
  let agentFetch: (req: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  const agentSrv = await listen((req) => agentFetch(req));

  // The real worker: fast test engine, mock partner (20ms callbacks), fake Stripe, real emitter POSTing to the agent.
  const envelopes: EventEnvelope[] = [];
  const fast = createFastEngine();
  const partner = createCountingPartner(20);
  const stripe = createFakeStripe();
  let clockOffset = 0;
  const workerLog = createLogger("worker-test", { level: process.env.TEST_LOG ? "debug" : "silent" });
  const worker = await createTestDeps({
    db,
    settlement: fast.engine,
    payouts: partner.partner,
    stripe: stripe.stripe,
    log: workerLog,
    now: () => new Date(Date.now() + clockOffset),
    config: { ...TEST_CONFIG, agentUrl: agentSrv.url },
    emit: createEmitter({
      db,
      agentUrl: agentSrv.url,
      secret: TEST_INTERNAL_SECRET,
      log: workerLog,
      backoffMs: [50],
      // Record every envelope the worker POSTs, so tests can re-deliver one (at-least-once delivery).
      fetch: async (input, init) => {
        if (typeof init?.body === "string") envelopes.push(JSON.parse(init.body) as EventEnvelope);
        return fetch(input, init);
      },
    }),
  });
  const stopPartner = startPartnerCallbacks(worker);
  const workerApp = createWorkerServer(worker);
  const workerSrv = await listen((req) => workerApp.fetch(req));

  const config = {
    ...baseConfig,
    offline: false,
    mockCards: true,
    internalSecret: TEST_INTERNAL_SECRET,
    workerUrl: workerSrv.url,
    publicBaseUrl: "https://rove.test",
    tokenSecret: "test-token-secret",
    anthropicApiKey: "",
  };

  const makeAgent = (now?: () => Date): AgentHandle => {
    const sends: RecordedSend[] = [];
    const replies: string[] = [];
    const workerCalls = new Map<string, number>();
    const http = createHttpWorker(config);
    const counted = Object.fromEntries(
      Object.entries(http).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          workerCalls.set(name, (workerCalls.get(name) ?? 0) + 1);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as WorkerClient;
    const agent = buildAgent({
      store: createDbStore(db),
      worker: counted,
      outbox: createConsoleOutbox({ log: () => {}, record: sends }),
      config,
      now,
      log: process.env.TEST_LOG ? (...a) => console.log("[agent]", ...a) : () => {},
    });
    const app = createServerApp(agent.deps, { events: agent.events, actions: agent.actions });
    agentFetch = (req) => app.fetch(req);
    return { agent, sends, replies, workerCalls };
  };

  let current = makeAgent(opts.agentNow);

  const world: World = {
    db,
    worker,
    fast,
    stripe,
    agentUrl: agentSrv.url,
    workerUrl: workerSrv.url,
    envelopes,
    async redeliver(envelope) {
      const res = await fetch(`${agentSrv.url}/internal/events`, {
        method: "POST",
        headers: internalHeaders(TEST_INTERNAL_SECRET),
        body: JSON.stringify(envelope),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    get agent() {
      return current.agent;
    },
    get sends() {
      return current.sends;
    },
    get replies() {
      return current.replies;
    },
    get workerCalls() {
      return current.workerCalls;
    },
    setWorkerClockOffset(ms) {
      clockOffset = ms;
    },
    restartAgent(o = {}) {
      current = makeAgent(o.now);
      return current;
    },
    async merchant() {
      return (await db.getMerchant(DEMO_MERCHANT.id))!;
    },
    async seedBalance(amount) {
      const m = money(amount, "SGD");
      await db.appendLedger({ merchantId: DEMO_MERCHANT.id, kind: "payment_credit", amount: m, ref: `pay_seed_${Math.random().toString(36).slice(2)}` });
      fast.credit(MERCHANT_ADDRESS, m);
    },
    async addBank() {
      const b = await worker.payouts.createBeneficiary({
        merchantId: DEMO_MERCHANT.id,
        type: "bank_account",
        bankName: "DBS",
        accountNumber: "0123451234",
        holderName: "Ah Seng Food Pte Ltd",
      });
      const row = await db.insertBankAccount({
        merchantId: DEMO_MERCHANT.id,
        type: "bank_account",
        bankName: "DBS",
        last4: b.last4,
        holderName: b.resolvedName,
        beneficiaryId: b.beneficiaryId,
        status: b.status,
      });
      return row.id;
    },
    async close() {
      stopPartner();
      await Promise.all([close(agentSrv.server), close(workerSrv.server)]);
      await db.close().catch(() => {});
    },
  };
  return world;
}

// ------------------------------------------------------------------ driving the agent without Claude

/** Calls a tool's run() the way the tool runner would (schema parse first), as the merchant or a customer. */
export async function callTool(w: World, as: "merchant" | Recipient, name: string, input: unknown): Promise<string> {
  const merchant = as === "merchant" ? await w.merchant() : null;
  const from = as === "merchant" ? MERCHANT : as;
  const calls: { name: string; input: unknown; result: string }[] = [];
  const ctx = { deps: w.agent.deps, from, merchant, actions: w.agent.actions, onboarding: w.agent.onboarding, calls };
  const tools: BetaRunnableTool[] = merchant ? [...merchantTools(ctx), ...customerTools(ctx)] : customerTools(ctx);
  const tool = tools.find((t) => (t as { name: string }).name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.run(tool.parse(input)));
}

/** Delivers one inbound message through the production router; replies land in w.replies. */
export async function inbound(w: World, from: Recipient, msg: Inbound): Promise<void> {
  let n = 0;
  await handleInbound(w.agent, from, msg, {
    async text(body) {
      w.replies.push(body);
      return { messageId: `reply-${++n}-${Date.now()}` };
    },
    responding: (fn) => fn(),
  });
}

export const text = (t: string): Inbound => ({ type: "text", text: t });
export const thumbsUp = (messageId: string): Inbound => ({ type: "reaction", emoji: "👍", targetMessageId: messageId });

/** Polls until `check` returns a truthy value. */
export async function waitFor<T>(what: string, check: () => T | Promise<T>, timeoutMs = 5000): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The most recent recorded send of this kind (e.g. "card:confirm") to this phone. */
export function lastSend(sends: RecordedSend[], kind: string, to?: string): RecordedSend | undefined {
  return [...sends].reverse().find((s) => s.kind === kind && (!to || s.to === to));
}

export function sendsOf(sends: RecordedSend[], kind: string, to?: string): RecordedSend[] {
  return sends.filter((s) => s.kind === kind && (!to || s.to === to));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
