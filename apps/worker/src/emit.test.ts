import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoveEvent } from "@rove/shared";
import { boot } from "./boot";
import { createEmitter } from "./emit";
import { createLogger } from "./log";
import { createFakeDb } from "./test-fakes";
import { createTestDeps } from "./testing";

const event: RoveEvent = { type: "merchant.live", merchantId: "ahseng", xrplAddress: "rMOCKAHSENG" };
const log = createLogger("test", { level: "silent" });

/** fetch stub answering from a script: a status code, or "throw" for a network error. */
function scriptedFetch(script: (number | "throw")[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step === "throw") throw new TypeError("fetch failed");
    return new Response(null, { status: step });
  }) as typeof fetch;
  return { fn, calls };
}

describe("createEmitter", () => {
  test("records, POSTs the envelope with the bearer token, marks delivered", async () => {
    const fake = createFakeDb();
    const f = scriptedFetch([202]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test/", secret: "s3cret", log, fetch: f.fn, backoffMs: [0, 0] });

    await emit(event);

    assert.equal(fake.events.length, 1);
    const envelope = fake.events[0]!;
    assert.match(envelope.id, /^evt_[0-9a-f]{32}$/);
    assert.deepEqual(envelope.event, event);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url, "http://agent.test/internal/events");
    assert.equal((f.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer s3cret");
    assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), envelope);
    assert.ok(fake.delivered.has(envelope.id));
  });

  test("retries network errors and 5xx, then marks delivered", async () => {
    const fake = createFakeDb();
    const f = scriptedFetch(["throw", 503, 200]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: f.fn, backoffMs: [0, 0] });

    await emit(event);

    assert.equal(f.calls.length, 3);
    assert.equal(fake.events.length, 1, "inserted once");
    assert.ok(fake.delivered.has(fake.events[0]!.id));
    const bodies = f.calls.map((c) => JSON.parse(String(c.init.body)).id);
    assert.equal(new Set(bodies).size, 1, "same envelope id on every try");
  });

  test("gives up after 3 tries without throwing; the event stays undelivered", async () => {
    const fake = createFakeDb();
    const f = scriptedFetch(["throw"]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: f.fn, backoffMs: [0, 0] });

    await emit(event); // must not reject

    assert.equal(f.calls.length, 3);
    assert.equal(fake.delivered.size, 0);
    assert.equal((await fake.db.listUndeliveredEvents()).length, 1);
  });

  test("doesn't retry a 4xx rejection", async () => {
    const fake = createFakeDb();
    const f = scriptedFetch([400]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: f.fn, backoffMs: [0, 0] });
    await emit(event);
    assert.equal(f.calls.length, 1);
    assert.equal(fake.delivered.size, 0);
  });

  test("a failing events insert doesn't stop delivery", async () => {
    const fake = createFakeDb();
    const db = { ...fake.db, insertEvent: async () => Promise.reject(new Error("db down")), markEventDelivered: fake.db.markEventDelivered };
    const f = scriptedFetch([200]);
    const emit = createEmitter({ db, agentUrl: "http://agent.test", secret: "s", log, fetch: f.fn, backoffMs: [0, 0] });
    await emit(event);
    assert.equal(f.calls.length, 1);
  });

  test("an invalid event is neither stored nor sent", async () => {
    const fake = createFakeDb();
    const f = scriptedFetch([200]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: f.fn, backoffMs: [0, 0] });
    await emit({ type: "merchant.live", merchantId: "ahseng" } as unknown as RoveEvent);
    assert.equal(fake.events.length, 0);
    assert.equal(f.calls.length, 0);
  });
});

describe("boot", () => {
  test("replays undelivered events with their original ids", async () => {
    const fake = createFakeDb();
    const down = scriptedFetch(["throw"]);
    const first = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: down.fn, backoffMs: [0, 0] });
    await first(event);
    await first({ type: "shop.updated", merchantId: "ahseng", fields: ["menu"] });
    const stored = fake.events.map((e) => e.id);

    const up = scriptedFetch([202]);
    const emit = createEmitter({ db: fake.db, agentUrl: "http://agent.test", secret: "s", log, fetch: up.fn, backoffMs: [0, 0] });
    const deps = await createTestDeps({ db: fake.db, emit });
    await boot(deps);

    assert.deepEqual(
      up.calls.map((c) => JSON.parse(String(c.init.body)).id),
      stored,
    );
    assert.equal(fake.events.length, 2, "replay doesn't insert again");
    assert.equal((await fake.db.listUndeliveredEvents()).length, 0);
  });
});
