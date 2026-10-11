import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardSpec, Recipient, SentMessage } from "@rove/shared";
import { createCardPresenter } from "./presenter";
import type { CardHandle, CardTransport } from "./presenter";
import { imessageAddress, recipientKey, whatsappAddress } from "./transport";

// ------------------------------------------------------------------ fake transport

type Call =
  | { op: "sendCard"; to: string; url: string; live: boolean }
  | { op: "editCard"; to: string; handle: CardHandle; url: string; live: boolean }
  | { op: "sendText"; to: string; body: string }
  | { op: "sendImage"; to: string; name: string; bytes: number; caption?: string };

interface FakeOptions {
  /** ms to wait before completing a call; return 0 for immediate. */
  delay?: (call: Call) => number;
  /** throw from this call instead of completing it. */
  fail?: (call: Call) => Error | undefined;
}

function fakeTransport(opts: FakeOptions = {}) {
  const calls: Call[] = []; // in completion order
  const started: Call[] = []; // in start order
  let n = 0;
  async function run<T>(call: Call, result: () => T): Promise<T> {
    started.push(call);
    const ms = opts.delay?.(call) ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    const err = opts.fail?.(call);
    if (err) throw err;
    calls.push(call);
    return result();
  }
  const transport: CardTransport = {
    supportsCards: (channel) => channel === "imessage",
    sendCard: (to, url, live) => {
      const id = `msg-${++n}`;
      return run({ op: "sendCard", to: recipientKey(to), url, live }, () => ({ messageId: id, handle: { handleOf: id } }));
    },
    editCard: (to, handle, url, live) => run({ op: "editCard", to: recipientKey(to), handle, url, live }, () => undefined),
    sendText: (to, body) => {
      const id = `msg-${++n}`;
      return run({ op: "sendText", to: recipientKey(to), body }, () => ({ messageId: id }));
    },
    sendImage: (to, png, name, caption) => {
      const id = `msg-${++n}`;
      return run({ op: "sendImage", to: recipientKey(to), name, bytes: png.byteLength, caption }, () => ({ messageId: id }));
    },
  };
  return { transport, calls, started };
}

// ------------------------------------------------------------------ fixtures

const merchantIM: Recipient = { phone: "+15555550100", channel: "imessage" };
const customerIM: Recipient = { phone: "+15555550199", channel: "imessage" };
const customerWA: Recipient = { phone: "+6591234567", channel: "whatsapp" };

function spec(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "setup",
    key: "setup:ahseng",
    url: "https://rove.test/setup?t=tok&v=a",
    live: true,
    fallbackText: "Set up Ah Seng Chicken Rice here.",
    ...over,
  };
}

const invoiceSpec = spec({
  kind: "invoice",
  key: "invoice:inv_9",
  url: "https://rove.test/pay/K7Q2MX?v=open",
  live: false,
  fallbackText: "Ah Seng Chicken Rice sent you a request for S$12.00",
});

// ------------------------------------------------------------------ tests

describe("phone normalization", () => {
  it("iMessage keeps E.164, WhatsApp is digits only", () => {
    assert.equal(imessageAddress("+65 9123-4567"), "+6591234567");
    assert.equal(imessageAddress("6591234567"), "+6591234567");
    assert.equal(imessageAddress("Maya@Example.com"), "maya@example.com");
    assert.equal(whatsappAddress("+65 (9123) 4567"), "6591234567");
    assert.equal(recipientKey({ phone: "+65 9123 4567", channel: "whatsapp" }), "whatsapp:6591234567");
    assert.throws(() => whatsappAddress("+"));
  });
});

describe("iMessage cards", () => {
  it("send then update edits the same bubble in place with the original handle", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);

    const sent = await p.send(merchantIM, spec());
    assert.deepEqual(sent, { messageId: "msg-1", edited: false });

    const updated = await p.update(merchantIM, spec({ url: "https://rove.test/setup?t=tok&v=b" }));
    assert.deepEqual(updated, { messageId: "msg-1", edited: true });

    assert.deepEqual(calls, [
      { op: "sendCard", to: "imessage:+15555550100", url: "https://rove.test/setup?t=tok&v=a", live: true },
      { op: "editCard", to: "imessage:+15555550100", handle: { handleOf: "msg-1" }, url: "https://rove.test/setup?t=tok&v=b", live: true },
    ]);

    // Repeated updates keep editing against the original handle.
    const again = await p.update(merchantIM, spec({ url: "https://rove.test/setup?t=tok&v=c" }));
    assert.deepEqual(again, { messageId: "msg-1", edited: true });
    assert.deepEqual(calls[2], { op: "editCard", to: "imessage:+15555550100", handle: { handleOf: "msg-1" }, url: "https://rove.test/setup?t=tok&v=c", live: true });
  });

  it("update for an unknown key sends a new card and remembers it", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);

    const first = await p.update(merchantIM, spec({ key: "withdrawal:wd_1", kind: "withdrawal", url: "https://rove.test/w/wd_1?v=pending" }));
    assert.deepEqual(first, { messageId: "msg-1", edited: false });
    const second = await p.update(merchantIM, spec({ key: "withdrawal:wd_1", kind: "withdrawal", url: "https://rove.test/w/wd_1?v=done" }));
    assert.deepEqual(second, { messageId: "msg-1", edited: true });
    assert.deepEqual(
      calls.map((c) => c.op),
      ["sendCard", "editCard"],
    );
  });

  it("handles are per recipient: the same key in another chat is a new bubble", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    await p.send(merchantIM, spec());
    const other = await p.update(customerIM, spec());
    assert.equal(other?.edited, false);
    assert.deepEqual(
      calls.map((c) => [c.op, c.to]),
      [
        ["sendCard", "imessage:+15555550100"],
        ["sendCard", "imessage:+15555550199"],
      ],
    );
  });

  it("formatting differences in the phone hit the same handle", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    await p.send({ phone: "+1 555 555 0100", channel: "imessage" }, spec());
    const u = await p.update(merchantIM, spec({ url: "https://rove.test/setup?v=b" }));
    assert.equal(u?.edited, true);
    assert.equal(calls[1]?.op, "editCard");
  });
});

describe("WhatsApp fallback", () => {
  it("send uses fallbackText + url as plain text", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    const sent = await p.send(customerWA, spec());
    assert.deepEqual(sent, { messageId: "msg-1", edited: false });
    assert.deepEqual(calls, [
      { op: "sendText", to: "whatsapp:6591234567", body: "Set up Ah Seng Chicken Rice here.\nhttps://rove.test/setup?t=tok&v=a" },
    ]);
  });

  it("invoice uses the template sender when provided", async () => {
    const { transport, calls } = fakeTransport();
    const templateCalls: Array<[Recipient, CardSpec]> = [];
    const p = createCardPresenter(transport, {
      waTemplates: {
        async invoice(to, s): Promise<SentMessage> {
          templateCalls.push([to, s]);
          return { messageId: "wamid.tpl1", edited: false };
        },
      },
    });
    const sent = await p.send(customerWA, invoiceSpec);
    assert.deepEqual(sent, { messageId: "wamid.tpl1", edited: false });
    assert.deepEqual(templateCalls, [[customerWA, invoiceSpec]]);
    assert.equal(calls.length, 0);

    // Non-invoice cards still go as text even with a template sender.
    await p.send(customerWA, spec());
    assert.equal(calls[0]?.op, "sendText");
  });

  it("invoice without a template sender falls back to text", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    await p.send(customerWA, invoiceSpec);
    assert.deepEqual(calls, [
      { op: "sendText", to: "whatsapp:6591234567", body: "Ah Seng Chicken Rice sent you a request for S$12.00\nhttps://rove.test/pay/K7Q2MX?v=open" },
    ]);
  });

  it("update with updateText sends a new text message; without it stays quiet", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    await p.send(customerWA, invoiceSpec);

    const quiet = await p.update(customerWA, { ...invoiceSpec, url: "https://rove.test/pay/K7Q2MX?v=viewed" });
    assert.equal(quiet, null);
    assert.equal(calls.length, 1);

    const paid = await p.update(customerWA, { ...invoiceSpec, url: "https://rove.test/pay/K7Q2MX?v=paid", updateText: "Paid ✓ S$12.00" });
    assert.deepEqual(paid, { messageId: "msg-2", edited: false });
    assert.deepEqual(calls[1], { op: "sendText", to: "whatsapp:6591234567", body: "Paid ✓ S$12.00\nhttps://rove.test/pay/K7Q2MX?v=paid" });
    assert.ok(!calls.some((c) => c.op === "editCard" || c.op === "sendCard"));
  });
});

describe("text and image", () => {
  it("pass through to the transport", async () => {
    const { transport, calls } = fakeTransport();
    const p = createCardPresenter(transport);
    assert.deepEqual(await p.text(merchantIM, "hi"), { messageId: "msg-1" });
    assert.deepEqual(await p.image(customerWA, new Uint8Array([1, 2, 3]), "qr.png", "Scan to pay"), { messageId: "msg-2" });
    assert.deepEqual(calls, [
      { op: "sendText", to: "imessage:+15555550100", body: "hi" },
      { op: "sendImage", to: "whatsapp:6591234567", name: "qr.png", bytes: 3, caption: "Scan to pay" },
    ]);
  });
});

describe("per-recipient serialization", () => {
  it("a slow first send still lands before the second for the same recipient", async () => {
    const { transport, calls, started } = fakeTransport({ delay: (c) => (c.op === "sendCard" ? 40 : 0) });
    const p = createCardPresenter(transport);

    const a = p.send(merchantIM, spec({ key: "sale:pay_1", kind: "sale" }));
    const b = p.text(merchantIM, "New sale: S$5.50");
    const c = p.update(merchantIM, spec({ key: "sale:pay_1", kind: "sale", url: "https://rove.test/r/pay_1?v=refunded" }));
    await Promise.all([a, b, c]);

    assert.deepEqual(
      calls.map((x) => x.op),
      ["sendCard", "sendText", "editCard"],
    );
    // The text didn't even start until the card send finished.
    assert.deepEqual(
      started.map((x) => x.op),
      ["sendCard", "sendText", "editCard"],
    );
    assert.equal((await c)?.edited, true); // update waited for the send, so it found the handle
  });

  it("different recipients run in parallel", async () => {
    let releaseMerchant!: () => void;
    const merchantGate = new Promise<void>((r) => (releaseMerchant = r));
    const { transport, calls } = fakeTransport();
    const slow: CardTransport = {
      ...transport,
      async sendCard(to, url, live) {
        if (recipientKey(to) === recipientKey(merchantIM)) await merchantGate;
        return transport.sendCard(to, url, live);
      },
    };
    const p = createCardPresenter(slow);

    const merchantSend = p.send(merchantIM, spec());
    const customerSend = await p.send(customerIM, invoiceSpec); // completes while the merchant send is blocked
    assert.equal(customerSend.edited, false);
    assert.deepEqual(
      calls.map((c) => c.to),
      ["imessage:+15555550199"],
    );

    releaseMerchant();
    await merchantSend;
    assert.deepEqual(
      calls.map((c) => c.to),
      ["imessage:+15555550199", "imessage:+15555550100"],
    );
  });

  it("an error propagates but does not block the next send to the same recipient", async () => {
    const boom = new Error("photon 503");
    const { transport, calls } = fakeTransport({
      delay: (c) => (c.op === "sendCard" ? 20 : 0),
      fail: (c) => (c.op === "sendCard" ? boom : undefined),
    });
    const p = createCardPresenter(transport);

    const failed = p.send(merchantIM, spec());
    const next = p.text(merchantIM, "still here");
    await assert.rejects(failed, boom);
    assert.deepEqual(await next, { messageId: "msg-2" });
    assert.deepEqual(calls, [{ op: "sendText", to: "imessage:+15555550100", body: "still here" }]);

    // The failed send left no handle: an update sends a new card rather than editing nothing.
    let cardAttempts = 0;
    const { transport: t2, calls: calls2 } = fakeTransport({ fail: (c) => (c.op === "sendCard" && ++cardAttempts === 1 ? boom : undefined) });
    const p2 = createCardPresenter(t2);
    await assert.rejects(p2.send(merchantIM, spec()), boom);
    const retried = await p2.update(merchantIM, spec());
    assert.equal(retried?.edited, false);
    assert.equal(calls2[0]?.op, "sendCard");
  });

  it("a failing edit rejects without wedging the queue", async () => {
    const { transport, calls } = fakeTransport({ fail: (c) => (c.op === "editCard" ? new Error("edit failed") : undefined) });
    const p = createCardPresenter(transport);
    await p.send(merchantIM, spec());
    await assert.rejects(p.update(merchantIM, spec({ url: "https://rove.test/setup?v=b" })), /edit failed/);
    assert.deepEqual(await p.text(merchantIM, "after"), { messageId: "msg-2" });
    assert.deepEqual(
      calls.map((c) => c.op),
      ["sendCard", "sendText"],
    );
  });

  it("an invalid recipient rejects instead of throwing synchronously", async () => {
    const { transport } = fakeTransport();
    const p = createCardPresenter(transport);
    await assert.rejects(p.text({ phone: "", channel: "whatsapp" }, "x"), /invalid WhatsApp recipient/);
  });
});
