// claim(), pending actions (claimed once, never after expiry), agent memory, onboarding, event outbox.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { EventEnvelope } from "@rove/shared";
import type { Db } from "./index";
import { liveMerchant, openTestDb, sgd } from "./testkit";

let db: Db;
before(async () => {
  ({ db } = await openTestDb());
  await liveMerchant(db, "act");
});
after(() => db.close());

const MIN = 60_000;

describe("claim", () => {
  it("is true the first time a key is seen, then false", async () => {
    assert.equal(await db.claim("stripe:evt_1"), true);
    assert.equal(await db.claim("stripe:evt_1"), false);
    assert.equal(await db.claim("stripe:evt_2"), true);
  });
});

describe("pending actions", () => {
  it("claimAction runs once; message ids find the open action", async () => {
    const a = await db.insertAction({ merchantId: "act", args: { kind: "refund", paymentId: "pay_1", amount: sgd("5.00"), reason: "cold food" } });
    assert.equal(a.kind, "refund");
    assert.equal(a.status, "proposed");
    assert.deepEqual(a.args, { kind: "refund", paymentId: "pay_1", amount: sgd("5.00"), reason: "cold food" });
    assert.deepEqual(a.confirmMessageIds, []);
    assert.ok(Math.abs(Date.parse(a.expiresAt) - Date.now() - 5 * MIN) < MIN);

    await db.addConfirmMessageIds(a.id, ["msg_1", "msg_2"]);
    await db.addConfirmMessageIds(a.id, ["msg_2", "msg_3"]);
    assert.deepEqual((await db.getAction(a.id))?.confirmMessageIds, ["msg_1", "msg_2", "msg_3"]);
    assert.equal((await db.findOpenActionByMessageId("msg_3"))?.id, a.id);
    assert.ok((await db.findOpenActionsForMerchant("act")).some((x) => x.id === a.id));

    const claimed = await db.claimAction(a.id);
    assert.equal(claimed?.status, "executing");
    assert.equal(await db.claimAction(a.id), null);
    assert.equal(await db.claimAction("act_missing"), null);
    assert.equal(await db.findOpenActionByMessageId("msg_3"), null); // no longer open

    const done = await db.setActionStatus(a.id, "done", { refundId: "ref_1" });
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.result, { refundId: "ref_1" });
    assert.deepEqual((await db.setActionStatus(a.id, "done"))?.result, { refundId: "ref_1" }); // kept when omitted
    assert.equal(await db.setActionStatus("act_missing", "failed"), null);
  });

  it("an expired action can't be claimed, and expireActions sweeps it once", async () => {
    const stale = await db.insertAction({
      merchantId: "act",
      args: { kind: "withdrawal", withdrawalId: "wd_1" },
      confirmMessageIds: ["msg_old"],
      expiresAt: new Date(Date.now() - MIN).toISOString(),
    });
    const fresh = await db.insertAction({ merchantId: "act", args: { kind: "set_auto_withdraw", mode: "daily" } });
    assert.equal(stale.kind, "withdrawal");
    assert.equal(await db.claimAction(stale.id), null);
    assert.equal(await db.findOpenActionByMessageId("msg_old"), null);
    assert.ok(!(await db.findOpenActionsForMerchant("act")).some((x) => x.id === stale.id));

    const swept = await db.expireActions();
    assert.deepEqual(swept.map((x) => [x.id, x.status]), [[stale.id, "expired"]]);
    assert.deepEqual(await db.expireActions(), []);
    assert.deepEqual((await db.expireActions(new Date(Date.now() + 10 * MIN))).map((x) => x.id), [fresh.id]);
    assert.equal(await db.claimAction(fresh.id), null);
  });

  it("findActionByMessageId finds any status; findActionByRef maps a withdrawal or payment to its action", async () => {
    const wd = await db.insertAction({ merchantId: "act", args: { kind: "withdrawal", withdrawalId: "wd_ref" }, confirmMessageIds: ["msg_ref"] });
    const rf = await db.insertAction({ merchantId: "act", args: { kind: "refund", paymentId: "pay_ref", amount: sgd("1.00"), reason: "x" } });
    await db.claimAction(wd.id);
    await db.setActionStatus(wd.id, "done");
    assert.equal(await db.findOpenActionByMessageId("msg_ref"), null); // not open any more
    assert.equal((await db.findActionByMessageId("msg_ref"))?.id, wd.id); // but still found, so a late 👍 can be answered
    assert.equal(await db.findActionByMessageId("msg_nobody"), null);
    assert.equal((await db.findActionByRef("wd_ref"))?.id, wd.id);
    assert.equal((await db.findActionByRef("pay_ref"))?.id, rf.id);
    assert.equal(await db.findActionByRef("wd_nobody"), null);
  });
});

describe("agent memory + onboarding", () => {
  it("recentAgentMessages returns the last N, oldest first, per phone", async () => {
    for (let i = 1; i <= 5; i++) {
      await db.appendAgentMessage({
        phone: "+65 9123 4567",
        persona: "merchant",
        merchantId: "act",
        role: i % 2 ? "user" : "assistant",
        content: `m${i}`,
        channel: "imessage",
      });
    }
    await db.appendAgentMessage({ phone: "+6500000001", persona: "customer", merchantId: null, role: "user", content: "other", channel: "whatsapp" });
    const recent = await db.recentAgentMessages("+6591234567", 3);
    assert.deepEqual(recent.map((m) => m.content), ["m3", "m4", "m5"]);
    assert.equal(recent[0]!.phone, "+6591234567");
    assert.equal(recent[0]!.merchantId, "act");
    assert.ok(!Number.isNaN(Date.parse(recent[0]!.createdAt)));
    assert.deepEqual(await db.recentAgentMessages("+6599999999", 10), []);
  });

  it("onboarding state upserts per phone", async () => {
    assert.equal(await db.getOnboarding("+6590001111"), null);
    await db.setOnboarding("+6590001111", "imessage", "name", {});
    await db.setOnboarding("+6590001111", "imessage", "category", { name: "Ah Seng Chicken Rice" });
    const s = await db.getOnboarding("+65 9000 1111");
    assert.equal(s?.step, "category");
    assert.deepEqual(s?.data, { name: "Ah Seng Chicken Rice" });
    assert.equal(s?.channel, "imessage");
  });
});

describe("events", () => {
  it("insertEvent is idempotent; undelivered come back oldest first until acked", async () => {
    const e1: EventEnvelope = {
      id: "evt_1",
      at: new Date(Date.now() - 2 * MIN).toISOString(),
      event: { type: "merchant.live", merchantId: "act", xrplAddress: "rMerchant" },
    };
    const e2: EventEnvelope = {
      id: "evt_2",
      at: new Date(Date.now() - MIN).toISOString(),
      event: { type: "shop.updated", merchantId: "act", fields: ["menu"] },
    };
    await db.insertEvent(e2);
    await db.insertEvent(e1);
    await db.insertEvent(e1);
    assert.deepEqual(await db.listUndeliveredEvents(), [e1, e2]);
    assert.deepEqual(await db.listUndeliveredEvents(1), [e1]);
    await db.markEventDelivered("evt_1");
    await db.markEventDelivered("evt_1");
    assert.deepEqual(await db.listUndeliveredEvents(), [e2]);
  });
});
