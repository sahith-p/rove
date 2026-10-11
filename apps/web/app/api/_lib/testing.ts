// Test helpers for Nithya's API routes. Owner: Nithya (NI-C1).
//
//   const deps = await useWebTestDeps();                       // PGlite db + mocks + capturing emitter, installed
//   const res = await PUT(new Request("http://x/api/me/menu", {
//     method: "PUT", headers: { "x-rove-session": sessionToken({ merchantId: "ahseng", scope: "setup" }) }, body }));
//   assert.deepEqual(deps.events.map((e) => e.type), ["shop.updated"]);
//
// createTestDb() (@rove/db/testing) throws until NI-B1 lands; pass `db` in overrides to avoid it.

import { createTestDb } from "@rove/db/testing";
import { signToken, type EventEnvelope, type MerchantSessionPayload, type RoveEvent } from "@rove/shared";
import { createMockPayoutPartner, createMockSettlement } from "@rove/shared/mocks";
import { setWebDepsForTests, type WebConfig, type WebDeps } from "./deps";
import type { Emit } from "./emit";

export const TEST_TOKEN_SECRET = "test-token-secret";
export const TEST_INTERNAL_SECRET = "test-internal-secret";

export const TEST_WEB_CONFIG: WebConfig = {
  publicBaseUrl: "http://web.test",
  internalSecret: TEST_INTERNAL_SECRET,
  workerUrl: "http://worker.test",
  agentUrl: "http://agent.test",
  stripeWebhookSecret: null,
  useMockSettlement: true,
  useMockPayouts: true,
};

export type WebTestDeps = WebDeps & { events: RoveEvent[]; envelopes: EventEnvelope[] };

/** An Emit that records instead of POSTing. */
export function createCapturingEmitter(): { emit: Emit; events: RoveEvent[]; envelopes: EventEnvelope[] } {
  const events: RoveEvent[] = [];
  const envelopes: EventEnvelope[] = [];
  let n = 0;
  const emit = async (event: RoveEvent) => {
    events.push(event);
    envelopes.push({ id: `evt_test${String(++n).padStart(4, "0")}`, at: new Date().toISOString(), event });
  };
  const deliver = async (envelope: EventEnvelope) => {
    envelopes.push(envelope);
    return true;
  };
  return { emit: Object.assign(emit, { deliver }), events, envelopes };
}

export async function createWebTestDeps(overrides: Partial<WebDeps> = {}): Promise<WebTestDeps> {
  const captured = createCapturingEmitter();
  ensureTokenSecret();
  return {
    db: overrides.db ?? (await createTestDb()),
    settlement: overrides.settlement ?? createMockSettlement(),
    payouts: overrides.payouts ?? createMockPayoutPartner(20),
    stripe: overrides.stripe ?? null,
    emit: overrides.emit ?? captured.emit,
    config: overrides.config ?? TEST_WEB_CONFIG,
    events: captured.events,
    envelopes: captured.envelopes,
  };
}

/** createWebTestDeps + setWebDepsForTests. Call setWebDepsForTests(null) in an `after` hook if other tests need real deps. */
export async function useWebTestDeps(overrides: Partial<WebDeps> = {}): Promise<WebTestDeps> {
  const deps = await createWebTestDeps(overrides);
  setWebDepsForTests(deps);
  return deps;
}

function ensureTokenSecret(): string {
  return (process.env.TOKEN_SECRET ||= TEST_TOKEN_SECRET);
}

/** A signed `x-rove-session` value. exp defaults to an hour from now; pass a past exp to test expiry. */
export function sessionToken(payload: Omit<MerchantSessionPayload, "exp"> & { exp?: number }): string {
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + 3600;
  return signToken<MerchantSessionPayload>({ ...payload, exp }, ensureTokenSecret());
}
