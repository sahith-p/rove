import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { money, PENDING_ACTION_TTL_MS } from "@rove/shared";
import { CUSTOMER, makeHarness, MERCHANT } from "./harness.test";
import { createServerApp } from "./server";

const fixture = JSON.parse(readFileSync(new URL("../evals/fixtures/payment.settled.json", import.meta.url), "utf8"));

function setup() {
  const h = makeHarness();
  const app = createServerApp(h.agent.deps, { events: h.agent.events, actions: h.agent.actions });
  const auth = { authorization: `Bearer ${h.agent.deps.config.internalSecret}`, "content-type": "application/json" };
  return { h, app, auth };
}

test("GET /health is open", async () => {
  const { app } = setup();
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("/internal/* rejects a missing or wrong bearer", async () => {
  const { app } = setup();
  const none = await app.request("/internal/events", { method: "POST", body: JSON.stringify(fixture), headers: { "content-type": "application/json" } });
  assert.equal(none.status, 401);
  const wrong = await app.request("/internal/events", {
    method: "POST",
    body: JSON.stringify(fixture),
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
  });
  assert.equal(wrong.status, 401);
  const confirm = await app.request("/internal/actions/act_x/confirm", { method: "POST", body: JSON.stringify({ via: "card" }) });
  assert.equal(confirm.status, 401);
});

test("POST /internal/events: 400 on a bad envelope or a non-JSON body", async () => {
  const { app, auth } = setup();
  const bad = await app.request("/internal/events", { method: "POST", headers: auth, body: JSON.stringify({ id: "x", event: { type: "nope" } }) });
  assert.equal(bad.status, 400);
  const body = (await bad.json()) as { error: string; issues: unknown[] };
  assert.equal(body.error, "invalid event");
  assert.ok(Array.isArray(body.issues));
  const notJson = await app.request("/internal/events", { method: "POST", headers: auth, body: "{" });
  assert.equal(notJson.status, 400);
});

test("POST /internal/events: 202 handled (sale card + receipt), then duplicate on resend with no new sends", async () => {
  const { h, app, auth } = setup();
  // The fixture points at seeded pay_demo0001 / inv_demo0001; pay it to a seeded invoice id instead so the
  // customer-side invoice edit has something to find.
  const env = structuredClone(fixture);
  env.event.payer = { phone: CUSTOMER.phone, channel: "imessage" };
  const first = await app.request("/internal/events", { method: "POST", headers: auth, body: JSON.stringify(env) });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: "handled" });
  assert.equal(h.sentTo(MERCHANT.phone, "card:sale").length, 1);
  assert.equal(h.sentTo(CUSTOMER.phone, "card:receipt").length, 1);
  assert.equal(h.sentTo(MERCHANT.phone, "effect").length, 1, "firstSale → confetti");

  const before = h.record.length;
  const again = await app.request("/internal/events", { method: "POST", headers: auth, body: JSON.stringify(env) });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: "duplicate" });
  assert.equal(h.record.length, before, "resend sends nothing");
});

test("POST /internal/actions/:id/confirm: 400 bad body, 404 unknown action", async () => {
  const { app, auth } = setup();
  const bad = await app.request("/internal/actions/act_x/confirm", { method: "POST", headers: auth, body: JSON.stringify({ via: "fax" }) });
  assert.equal(bad.status, 400);
  const missing = await app.request("/internal/actions/act_missing/confirm", { method: "POST", headers: auth, body: JSON.stringify({ via: "card" }) });
  assert.equal(missing.status, 404);
});

test("POST /internal/actions/:id/confirm: 200 with a PendingActionView, then 409 for an expired one", async () => {
  const { h, app, auth } = setup();
  const merchant = (await h.agent.deps.store.getMerchant("ahseng"))!;
  const a = await h.agent.actions.propose(merchant, "set_auto_withdraw", { kind: "set_auto_withdraw", mode: "daily" }, "Turn daily auto-withdraw on");
  const ok = await app.request(`/internal/actions/${a.id}/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ via: "card" }) });
  assert.equal(ok.status, 200);
  const view = (await ok.json()) as { action: Record<string, unknown> };
  assert.deepEqual(Object.keys(view.action).sort(), ["expiresAt", "id", "kind", "status", "summary"]);
  assert.equal(view.action.id, a.id);
  assert.equal(view.action.kind, "set_auto_withdraw");
  assert.equal(view.action.status, "done");
  assert.equal(view.action.summary, "Turn daily auto-withdraw on");
  assert.equal(h.workerCalls.setAutoWithdraw, 1);

  const b = await h.agent.actions.propose(
    merchant,
    "refund",
    { kind: "refund", paymentId: "pay_demo0001", amount: money("1.00", "SGD"), reason: "test" },
    "Refund S$1.00 to Maya",
  );
  h.advance(PENDING_ACTION_TTL_MS + 1000);
  const late = await app.request(`/internal/actions/${b.id}/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ via: "web" }) });
  assert.equal(late.status, 409);
  const lateView = (await late.json()) as { action: { id: string } };
  assert.equal(lateView.action.id, b.id);
  assert.equal(h.workerCalls.refund, 0);
});
