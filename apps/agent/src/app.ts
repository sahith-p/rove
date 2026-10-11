// Wires the agent's modules from a Deps bag. index.ts (the real runtime) and evals/run.ts (in-process harness)
// both build an Agent here, so evals exercise exactly the production routing, tools and confirmations.

import { links, signToken, TOKEN_TTL_SEC, type EventEnvelope } from "@rove/shared";
import { createActions } from "./actions";
import { createTurnRunner } from "./agent/run";
import { createBuilders, createQrImages } from "./cards";
import { config as defaultConfig, type Config } from "./env";
import { createEventsHandler } from "./events";
import { createOnboarding } from "./onboarding";
import type { ActionsService, Deps, EventsHandler, OnboardingFlow, Outbox, Store, TurnRunner, Voice, WorkerClient } from "./ports";
import { createDbStore } from "./store/db";
import { createMemoryStore } from "./store/memory";
import { createVoice } from "./voice";
import { createHttpWorker, createMockWorker } from "./worker";

export interface Agent {
  deps: Deps;
  actions: ActionsService;
  onboarding: OnboardingFlow;
  events: EventsHandler;
  turns: TurnRunner;
  voice: Voice;
}

export interface BuildOptions {
  outbox: Outbox;
  config?: Config;
  store?: Store;
  worker?: WorkerClient;
  now?: () => Date;
  log?: (...args: unknown[]) => void;
  /** Mock worker step delay (evals use 0). */
  mockStepDelayMs?: number;
}

export function buildAgent(opts: BuildOptions): Agent {
  const config = opts.config ?? defaultConfig;
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? (config.offline ? createMemoryStore({ now }) : createDbStore());

  // The mock worker emits events back into this agent, like the real worker does over HTTP.
  let events: EventsHandler | null = null;
  const emit = (e: EventEnvelope) => (events ? events.handle(e) : Promise.resolve("handled"));
  const worker =
    opts.worker ?? (config.offline ? createMockWorker(store, emit, { stepDelayMs: opts.mockStepDelayMs }) : createHttpWorker(config));

  const nowSec = () => Math.floor(now().getTime() / 1000);
  const deps: Deps = {
    config,
    store,
    worker,
    outbox: opts.outbox,
    builders: createBuilders(config.publicBaseUrl),
    links: links(config.publicBaseUrl),
    qr: createQrImages(),
    log: opts.log ?? ((...args) => console.log("[agent]", ...args)),
    now,
    sessionToken: (merchantId, scope, ref) =>
      signToken({ merchantId, scope, ...(ref ? { ref } : {}), exp: nowSec() + TOKEN_TTL_SEC[scope] }, config.tokenSecret),
    confirmToken: (actionId, merchantId) => signToken({ actionId, merchantId, exp: nowSec() + TOKEN_TTL_SEC.confirm }, config.tokenSecret),
  };

  const actions = createActions(deps);
  const onboarding = createOnboarding(deps);
  events = createEventsHandler(deps, { actions, onboarding });
  const turns = createTurnRunner(deps, { actions, onboarding });
  const voice = createVoice(deps);
  return { deps, actions, onboarding, events, turns, voice };
}
