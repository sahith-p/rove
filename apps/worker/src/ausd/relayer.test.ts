// AUSD relayer state machine against PGlite and a fake Base Sepolia chain (no network).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import type { AusdAuthorization } from "@rove/db";
import { createTestDb } from "@rove/db/testing";
import { money, newId, type InvoiceLine, type Payment } from "@rove/shared";
import { createTestDeps, type TestDeps } from "../testing";
import { ausdRelayerConfigFromEnv, relayCalldata, RelayRevertedError, splitSignature, type AusdRelayChain, type AusdRelayerConfig } from "./chain";
import { startAusdRelayer } from "./index";
import { createRelayerState, relayTick, type RelayerOptions } from "./relayer";

const PAY_TO = getAddress("0xaD0E193bcd9A035aCb383681Bb21F7C3099f584B");
const PAYER = getAddress("0x57db62B364808Ad7FFa7210169c2abeA2ef39B25");
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

const CONFIG: AusdRelayerConfig = {
  rpcUrl: "http://base-sepolia.test",
  token: getAddress("0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC"),
  payTo: PAY_TO,
  relayerPrivateKey: `0x${"ab".repeat(32)}`,
  confirmations: 2,
  pollMs: 50,
  maxAttempts: 5,
  resendAfterMs: 60_000,
  maxReverts: 3,
};

const LINES: InvoiceLine[] = [{ menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 1, unit: money("12.50", "SGD") }];

interface Tx {
  a: AusdAuthorization;
  block: bigint | null;
  status: "success" | "reverted";
}

function createFakeChain() {
  const used = new Set<string>();
  const signed = new Map<Hex, { hash: Hex; a: AusdAuthorization }>();
  const txs = new Map<Hex, Tx>();
  const calls = { sign: 0, broadcast: 0 };
  const knobs = { reverts: 0, rpcDown: false, dropBroadcast: false };
  let head = 1000n;
  let n = 0;
  const key = (from: string, nonce: string) => `${from.toLowerCase()}:${nonce.toLowerCase()}`;

  const chain: AusdRelayChain = {
    relayer: getAddress("0x34E6f183d9400549059a1e5A2Ff285d0000beFDC"),
    async authorizationState(from, nonce) {
      return used.has(key(from, nonce));
    },
    async signRelay(a) {
      calls.sign++;
      if (knobs.rpcDown) throw new Error("fetch failed");
      if (knobs.reverts > 0) {
        knobs.reverts--;
        throw new RelayRevertedError("Execution reverted for an unknown reason.");
      }
      const hash = keccak256(toHex(`relay-${++n}`));
      const serialized = toHex(`raw-${n}`);
      signed.set(serialized, { hash, a });
      return { hash, serialized };
    },
    async broadcast(serialized) {
      calls.broadcast++;
      if (knobs.dropBroadcast) throw new Error("connection reset");
      const s = signed.get(serialized)!;
      txs.set(s.hash, { a: s.a, block: null, status: "success" });
    },
    async getReceipt(hash) {
      const t = txs.get(hash);
      if (!t || t.block === null) return null;
      return { status: t.status, blockNumber: t.block, transferred: t.status === "success" };
    },
    async txKnown(hash) {
      return txs.has(hash);
    },
    async blockNumber() {
      return head;
    },
  };

  return {
    chain,
    calls,
    knobs,
    used,
    /** Mine every pending tx in the current head block; an already-used authorization reverts (one-shot on-chain). */
    mine() {
      for (const t of txs.values()) {
        if (t.block !== null) continue;
        t.block = head;
        const k = key(t.a.from, t.a.nonce);
        t.status = used.has(k) ? "reverted" : "success";
        used.add(k);
      }
    },
    advance(blocks: number) {
      head += BigInt(blocks);
    },
  };
}

let deps: TestDeps;
let fake: ReturnType<typeof createFakeChain>;
let authorizedCalls: Payment[];
let opts: RelayerOptions;

beforeEach(async () => {
  deps = await createTestDeps({ db: await createTestDb({ demo: true }) });
  fake = createFakeChain();
  authorizedCalls = [];
  opts = { config: CONFIG, chain: fake.chain, onAuthorized: (p) => authorizedCalls.push(p) };
});
afterEach(async () => {
  await deps.db.close();
});

let nonceSeq = 0;
function auth(overrides: Partial<AusdAuthorization> = {}): AusdAuthorization {
  return {
    from: PAYER,
    to: PAY_TO,
    value: "9690000",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: keccak256(toHex(`nonce-${++nonceSeq}`)),
    signature: SIG,
    ...overrides,
  };
}

async function ausdPayment(a: AusdAuthorization = auth(), invoiceId: string | null = null) {
  return deps.db.insertAusdPayment(
    {
      id: newId("pay"),
      merchantId: "ahseng",
      source: invoiceId ? "invoice" : "fixed_qr",
      invoiceId,
      lines: LINES,
      local: money("12.50", "SGD"),
      quote: { local: money("12.50", "SGD"), usd: money("9.69", "USD"), rate: "1.29", sendMaxUsd: "9.79", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      charge: money("9.69", "USD"),
      method: "ausd",
      payer: null,
    },
    a,
  );
}

const status = async (id: string) => (await deps.db.getPayment(id))!.status;

describe("AUSD relayer", () => {
  test("relays once, waits for 2 confirmations, then claims and authorizes (payinTxHash) and hands off to settle", async () => {
    const p = await ausdPayment();
    const state = createRelayerState();

    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "sent" });
    const relay = await deps.db.getAusdRelay(p.id);
    assert.ok(relay?.relayTxHash);
    assert.equal(relay?.relayAttempts, 1);
    const hash = relay!.relayTxHash!;

    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "pending" });
    fake.mine();
    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "confirming" });
    fake.advance(1);
    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "authorized" });

    assert.deepEqual([fake.calls.sign, fake.calls.broadcast], [1, 1]);
    assert.equal(await status(p.id), "authorized");
    assert.equal((await deps.db.getAusdRelay(p.id))?.payinTxHash, hash);
    assert.equal(await deps.db.claim(`ausd:${hash.toLowerCase()}`), false, "the tx was claimed");
    assert.deepEqual(
      authorizedCalls.map((x) => x.id),
      [p.id],
    );
    assert.deepEqual(await relayTick(deps, opts, state), {}, "nothing left to relay");
  });

  test("a restarted worker finds its own mined tx by hash and never relays again", async () => {
    const p = await ausdPayment();
    await relayTick(deps, opts, createRelayerState());
    fake.mine();
    fake.advance(5);
    // fresh relayer state = new process
    assert.deepEqual(await relayTick(deps, opts, createRelayerState()), { [p.id]: "authorized" });
    assert.equal(fake.calls.sign, 1);
  });

  test("hash recorded but the broadcast was lost: waits, then signs again; authorizationState keeps it single-use", async () => {
    const p = await ausdPayment();
    fake.knobs.dropBroadcast = true;
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "sent" });
    const first = (await deps.db.getAusdRelay(p.id))!.relayTxHash;
    fake.knobs.dropBroadcast = false;

    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "pending" }, "not resent before resendAfterMs");
    const later = { ...opts, now: () => Date.now() + 61_000 };
    assert.deepEqual(await relayTick(deps, later), { [p.id]: "sent" });
    const relay = (await deps.db.getAusdRelay(p.id))!;
    assert.notEqual(relay.relayTxHash, first);
    assert.equal(relay.relayAttempts, 2);

    fake.mine();
    fake.advance(1);
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "authorized" });
    assert.equal((await deps.db.getAusdRelay(p.id))?.payinTxHash, relay.relayTxHash);
  });

  test("authorization used or cancelled outside Rove → failed, nothing sent, payment.failed emitted", async () => {
    const a = auth();
    fake.used.add(`${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`);
    const p = await ausdPayment(a);
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "failed" });
    assert.equal(fake.calls.sign, 0);
    assert.equal(await status(p.id), "failed");
    assert.match((await deps.db.getAusdRelay(p.id))!.failureReason!, /^authorization_used_elsewhere/);
    assert.deepEqual(
      deps.events.map((e) => e.type),
      ["payment.failed"],
    );
  });

  test("expired authorization → failed; an authorization that doesn't pay AUSD_PAY_TO is never relayed", async () => {
    const expired = await ausdPayment(auth({ validBefore: String(Math.floor(Date.now() / 1000) - 1) }));
    const elsewhere = await ausdPayment(auth({ to: PAYER }));
    const out = await relayTick(deps, opts);
    assert.deepEqual(out, { [expired.id]: "failed", [elsewhere.id]: "failed" });
    assert.match((await deps.db.getAusdRelay(expired.id))!.failureReason!, /^authorization_expired/);
    assert.match((await deps.db.getAusdRelay(elsewhere.id))!.failureReason!, /not AUSD_PAY_TO/);
    assert.equal(fake.calls.sign, 0);
  });

  test("simulation reverts are retried, then fail the payment; RPC errors only retry", async () => {
    const p = await ausdPayment();
    const state = createRelayerState();
    fake.knobs.reverts = 3;
    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "retry" });
    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "retry" });
    assert.deepEqual(await relayTick(deps, opts, state), { [p.id]: "failed" });
    assert.match((await deps.db.getAusdRelay(p.id))!.failureReason!, /^relay_reverted/);

    const q = await ausdPayment();
    fake.knobs.rpcDown = true;
    for (let i = 0; i < 5; i++) assert.deepEqual(await relayTick(deps, opts, state), { [q.id]: "retry" });
    assert.equal(await status(q.id), "created");
    assert.equal(fake.calls.broadcast, 0);
  });

  test("invoice paid another way before the relay → failed without moving AUSD", async () => {
    const inv = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: money("12.50", "SGD") });
    const p = await ausdPayment(auth(), inv.id);
    await deps.db.markInvoicePaid(inv.id, "pay_card_elsewhere");
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "failed" });
    assert.equal(fake.calls.sign, 0);
    assert.match((await deps.db.getAusdRelay(p.id))!.failureReason!, /^invoice_already_paid/);
  });

  test("invoice paid another way while the AUSD was in flight → CAS conflict → failed with a manual refund note", async () => {
    const inv = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: money("12.50", "SGD") });
    const p = await ausdPayment(auth(), inv.id);
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "sent" });

    const card = await deps.db.insertPayment({
      id: newId("pay"),
      merchantId: "ahseng",
      source: "invoice",
      invoiceId: inv.id,
      lines: LINES,
      local: money("12.50", "SGD"),
      quote: null,
      charge: money("12.50", "SGD"),
      method: "card",
      payer: null,
    });
    assert.ok(await deps.db.transitionPayment(card.id, ["created"], "authorized"));

    fake.mine();
    fake.advance(1);
    assert.deepEqual(await relayTick(deps, opts), { [p.id]: "failed" });
    const relay = (await deps.db.getAusdRelay(p.id))!;
    assert.equal(relay.payment.status, "failed");
    assert.match(relay.failureReason!, /^invoice_already_paid: AUSD received in 0x[0-9a-f]{64}, refund 9690000 base units/);
    assert.equal(relay.payinTxHash, relay.relayTxHash);
    assert.deepEqual(authorizedCalls, []);
  });
});

describe("AUSD relayer config + calldata", () => {
  test("off without a key; refuses malformed values; never needs the key anywhere else", () => {
    assert.equal(ausdRelayerConfigFromEnv({}), null);
    assert.throws(() => ausdRelayerConfigFromEnv({ AUSD_RELAYER_PRIVATE_KEY: "0x12", AUSD_PAY_TO: PAY_TO }), /32 bytes/);
    assert.throws(() => ausdRelayerConfigFromEnv({ AUSD_RELAYER_PRIVATE_KEY: CONFIG.relayerPrivateKey }), /AUSD_PAY_TO/);
    const c = ausdRelayerConfigFromEnv({ AUSD_RELAYER_PRIVATE_KEY: CONFIG.relayerPrivateKey, AUSD_PAY_TO: PAY_TO.toLowerCase() })!;
    assert.deepEqual([c.token, c.payTo, c.confirmations, c.rpcUrl], [CONFIG.token, PAY_TO, 2, "https://sepolia.base.org"]);
  });

  test("startAusdRelayer is a no-op without config, and with bad config it logs instead of crashing the worker", () => {
    startAusdRelayer(deps, {})();
    startAusdRelayer(deps, { AUSD_RELAYER_PRIVATE_KEY: "nope" })();
  });

  test("calldata targets transferWithAuthorization(…, v, r, s) with v 27/28", () => {
    assert.deepEqual(splitSignature(SIG), { v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` });
    assert.equal(splitSignature(`0x${"11".repeat(32)}${"22".repeat(32)}01` as Hex).v, 28);
    assert.equal(relayCalldata(auth()).slice(0, 10), "0xe3ee160e"); // selector verified on the token's implementation
  });
});
