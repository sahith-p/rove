import assert from "node:assert/strict";
import { test } from "node:test";
import { CUSTOMER, makeHarness, MERCHANT } from "./harness.test";
import type { Voice } from "./ports";
import { startReminders } from "./reminders";

// Default timezone in tests is Asia/Singapore (AGENT_TIMEZONE isn't loaded). 13:30Z = 21:30 SGT.
const EVENING = new Date("2026-10-11T13:30:00.000Z");
const MORNING = new Date("2026-10-11T01:00:00.000Z"); // 09:00 SGT

function voice(spoken: string[]): Voice {
  return {
    transcribe: async () => "",
    speak: async (text) => {
      spoken.push(text);
      return { audio: Buffer.from("m4a"), mimeType: "audio/mp4", name: "recap.m4a", duration: 3 };
    },
  };
}

test("an unpaid invoice gets exactly one nudge (text + card) across two runs", async () => {
  const h = makeHarness({ start: MORNING });
  const r = startReminders(h.agent.deps, { voice: voice([]) });
  try {
    await r.runOnce();
    assert.equal(h.texts(CUSTOMER.phone).length, 0, "not yet 24h old");
    h.advance(25 * 3600 * 1000);
    await r.runOnce();
    await r.runOnce();
    const nudges = h.texts(CUSTOMER.phone);
    assert.equal(nudges.length, 1);
    assert.match(nudges[0]!, /Friendly reminder from Ah Seng Chicken Rice: S\$6\.50/);
    assert.equal(h.sentTo(CUSTOMER.phone, "card:invoice").length, 1);
  } finally {
    r.stop();
  }
});

test("paid and one-time-QR invoices are never nudged", async () => {
  const h = makeHarness({ start: MORNING });
  await h.agent.deps.store.mock!.payInvoice("M4YA22", CUSTOMER);
  const r = startReminders(h.agent.deps, { voice: voice([]) });
  try {
    h.advance(25 * 3600 * 1000);
    await r.runOnce();
    assert.equal(h.texts(CUSTOMER.phone).length, 0);
  } finally {
    r.stop();
  }
});

test("recap: once per merchant per local day, only after the recap hour, text + voice note", async () => {
  const h = makeHarness({ start: MORNING });
  const spoken: string[] = [];
  const r = startReminders(h.agent.deps, { voice: voice(spoken) });
  try {
    await r.runOnce();
    assert.equal(h.texts(MERCHANT.phone).length, 0, "09:00 is before the recap hour");

    // Seeded payments are 2h before the harness start → same SGT day as 21:30 when we start in the evening.
    const e = makeHarness({ start: EVENING });
    const spokenE: string[] = [];
    const re = startReminders(e.agent.deps, { voice: voice(spokenE) });
    try {
      await re.runOnce();
      await re.runOnce();
      const t = e.texts(MERCHANT.phone);
      assert.equal(t.length, 1);
      assert.equal(t[0], "2 sales today, S$20.50 net.");
      assert.equal(e.sentTo(MERCHANT.phone, "voice").length, 1);
      assert.equal(spokenE.length, 1);
      assert.match(spokenE[0]!, /^Two sales today, 20 dollars 50 net\.$/);
      // Uncle's Kopi has no sales: no recap.
      assert.equal(e.texts("+6590001111").length, 0);
    } finally {
      re.stop();
    }
  } finally {
    r.stop();
  }
});

test("recap with no voice configured still sends the text", async () => {
  const h = makeHarness({ start: EVENING });
  const r = startReminders(h.agent.deps, { voice: { transcribe: async () => "", speak: async () => null } });
  try {
    await r.runOnce();
    assert.equal(h.texts(MERCHANT.phone).length, 1);
    assert.equal(h.sentTo(MERCHANT.phone, "voice").length, 0);
  } finally {
    r.stop();
  }
});
