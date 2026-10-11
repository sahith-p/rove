// Test helpers for worker modules. Owner: Nithya (NI-C1).
//
//   const deps = await createTestDeps();                 // PGlite db (@rove/db/testing), mock engine + partner
//   await createMerchant(deps, {...});
//   assert.deepEqual(deps.events.map((e) => e.type), ["merchant.live"]);
//
// Override anything: createTestDeps({ db: fakeDb, settlement: stubEngine, now: () => fixedDate }).
// `db` is only built when you don't pass one (createTestDb() throws until NI-B1 lands).

import { createTestDb } from "@rove/db/testing";
import type { EventEnvelope, RoveEvent } from "@rove/shared";
import { createMockPayoutPartners, createMockSettlement } from "@rove/shared/mocks";
import type { WorkerConfig, WorkerDeps } from "./deps";
import type { Emit } from "./emit";
import { createLogger } from "./log";

export const TEST_INTERNAL_SECRET = "test-internal-secret";

export const TEST_CONFIG: WorkerConfig = {
  port: 0,
  internalSecret: TEST_INTERNAL_SECRET,
  agentUrl: "http://agent.test",
  publicBaseUrl: "http://web.test",
  useMockSettlement: true,
  useMockPayouts: true,
  intervals: { settlePoll: 50, expiry: 50, reconcile: 50, autoWithdraw: 50 },
};

export interface CapturingEmitter {
  emit: Emit;
  /** Every event emitted, in order. */
  events: RoveEvent[];
  /** The envelopes, including ones passed to emit.deliver (replays). */
  envelopes: EventEnvelope[];
}

/** An Emit that records instead of POSTing. */
export function createCapturingEmitter(now: () => Date = () => new Date()): CapturingEmitter {
  const events: RoveEvent[] = [];
  const envelopes: EventEnvelope[] = [];
  let n = 0;
  const emit = async (event: RoveEvent) => {
    events.push(event);
    envelopes.push({ id: `evt_test${String(++n).padStart(4, "0")}`, at: now().toISOString(), event });
  };
  const deliver = async (envelope: EventEnvelope) => {
    envelopes.push(envelope);
    return true;
  };
  return { emit: Object.assign(emit, { deliver }), events, envelopes };
}

export type TestDeps = WorkerDeps & { events: RoveEvent[]; envelopes: EventEnvelope[] };

export async function createTestDeps(overrides: Partial<WorkerDeps> = {}): Promise<TestDeps> {
  const now = overrides.now ?? (() => new Date());
  const captured = createCapturingEmitter(now);
  const deps: WorkerDeps = {
    db: overrides.db ?? (await createTestDb()),
    settlement: overrides.settlement ?? createMockSettlement(),
    payouts: overrides.payouts ?? createMockPayoutPartners(20),
    stripe: overrides.stripe ?? null,
    emit: overrides.emit ?? captured.emit,
    config: overrides.config ?? TEST_CONFIG,
    log: overrides.log ?? createLogger("test", { level: process.env.TEST_LOG ? "debug" : "silent" }),
    now,
  };
  return { ...deps, events: captured.events, envelopes: captured.envelopes };
}
