// x402 v2 over /api/x402/invoices/:code with PGlite, the mock settlement engine (S$12.50 → US$9.69), a fake Base Sepolia
// reader and a fake relayer (the worker's job) that lands the transfer.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { keccak256, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { createTestDb } from "@rove/db/testing";
import { money, type Invoice, type InvoiceLine } from "@rove/shared";
import { setAusdDepsForTests, type AusdDeps } from "../_lib/ausd";
import { testPayer, useAusdTestDeps, type FakeAusdChain } from "../_lib/ausd-testing";
import { setWebDepsForTests } from "../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { buildPaymentPayload, payX402, readPaymentRequired } from "./client";
import { handleX402Invoice, type X402Options } from "./invoice";
import { GET } from "./invoices/[code]/route";
import { decodeHeader, encodeHeader, PaymentRequiredZ, X402_HEADERS, type PaymentPayload, type SettlementResponse } from "./protocol";

const LINES: InvoiceLine[] = [
  { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
  { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
];

let deps: WebTestDeps;
let ausd: AusdDeps & { chain: FakeAusdChain };
let agent: PrivateKeyAccount;
let inv: Invoice;

beforeEach(async () => {
  deps = await useWebTestDeps({ db: await createTestDb({ demo: true }) });
  ausd = useAusdTestDeps();
  agent = testPayer();
  ausd.chain.fund(agent.address, 10_000_000_000n); // 10,000 AUSD, like the faucet
  inv = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: money("12.50", "SGD") });
});
afterEach(async () => {
  setWebDepsForTests(null);
  setAusdDepsForTests(null);
  await deps.db.close();
});

const url = (code: string) => `http://web.test/api/x402/invoices/${code}`;
const FAST: X402Options = { waitMs: 1_500, pollMs: 5 };

/** Calls the handler the way the route does, with short waits. */
function call(code: string, headers: Record<string, string> = {}, opts: X402Options = FAST) {
  return handleX402Invoice(new Request(url(code), { headers }), code, deps, ausd, opts);
}

/** The worker's job, faked: relay every stored authorization and mark it authorized (or failed). */
function fakeRelayer(outcome: "authorized" | "failed" = "authorized", delayMs = 20) {
  let stopped = false;
  const hashes: string[] = [];
  const loop = (async () => {
    while (!stopped) {
      for (const job of await deps.db.listAusdAwaitingRelay()) {
        await new Promise((r) => setTimeout(r, delayMs));
        const hash = keccak256(toHex(`relay:${job.payment.id}`));
        await deps.db.setAusdRelayTx(job.payment.id, hash);
        if (outcome === "authorized") await deps.db.transitionPayment(job.payment.id, ["created"], "authorized", { payinTxHash: hash });
        else await deps.db.transitionPayment(job.payment.id, ["created"], "failed", { failureReason: "relay_reverted: test" });
        hashes.push(hash);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return {
    hashes,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

async function signedHeader(code = inv.code, mutate: (p: PaymentPayload) => void = () => {}): Promise<string> {
  const required = await readPaymentRequired(await call(code));
  const payload = await buildPaymentPayload(agent, required);
  mutate(payload);
  return encodeHeader(payload);
}

const settlement = (res: Response, name: string = X402_HEADERS.response) => {
  const h = res.headers.get(name);
  return h ? (decodeHeader(h) as SettlementResponse) : null;
};

describe("x402 · 402 Payment Required", () => {
  test("body and PAYMENT-REQUIRED header carry the v2 PaymentRequired for the open invoice", async () => {
    const res = await GET(new Request(url(inv.code)), { params: Promise.resolve({ code: inv.code }) });
    assert.equal(res.status, 402);
    const body = PaymentRequiredZ.parse(await res.json());
    assert.deepEqual(decodeHeader(res.headers.get(X402_HEADERS.required)!), body);

    assert.equal(body.x402Version, 2);
    assert.equal(body.error, "PAYMENT-SIGNATURE header is required");
    assert.deepEqual(body.resource, { url: url(inv.code), description: "Ah Seng Chicken Rice · S$12.50", mimeType: "application/json" });
    assert.equal(body.accepts.length, 1);
    const r = body.accepts[0]!;
    assert.deepEqual(
      { scheme: r.scheme, network: r.network, amount: r.amount, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds },
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "9690000", // US$9.69 in AUSD base units (6 decimals)
        asset: ausd.config.token,
        payTo: ausd.config.payTo,
        maxTimeoutSeconds: 600,
      },
    );
    assert.equal(r.extra?.assetTransferMethod, "eip3009");
    assert.equal(r.extra?.name, "Agora Dollar");
    assert.equal(r.extra?.version, "1");
    assert.equal(typeof r.extra?.roveQuote, "string");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("unknown → 404; paid, cancelled or expired invoices → 410", async () => {
    assert.equal((await call("NOPE00")).status, 404);
    await deps.db.cancelInvoice("ahseng", inv.code);
    const cancelled = await call(inv.code);
    assert.deepEqual([cancelled.status, ((await cancelled.json()) as { error: string }).error], [410, "invoice_cancelled"]);
    const old = await deps.db.createInvoice({
      merchantId: "ahseng",
      kind: "invoice",
      lines: LINES,
      total: money("12.50", "SGD"),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal((await call(old.code)).status, 410);
  });
});

describe("x402 · paying", () => {
  test("happy path: verify → ausd payment + stored authorization → relayer → 200 receipt + PAYMENT-RESPONSE", async () => {
    const relayer = fakeRelayer();
    try {
      const header = await signedHeader();
      const res = await call(inv.code, { [X402_HEADERS.signature]: header });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.status, "authorized");
      assert.equal(body.receiptUrl, `http://web.test/r/${body.paymentId}`);
      assert.equal(body.merchant, "Ah Seng Chicken Rice");
      assert.deepEqual(body.charge, money("9.69", "USD"));
      assert.equal(body.ausd.amount, "9690000");
      assert.equal(body.ausd.payer, agent.address);
      assert.equal(body.ausd.transaction, relayer.hashes[0]);
      assert.equal(body.ausd.explorerUrl, `https://sepolia.basescan.org/tx/${relayer.hashes[0]}`);

      const pr = settlement(res)!;
      assert.deepEqual(pr, { success: true, transaction: relayer.hashes[0], network: "eip155:84532", payer: agent.address, amount: "9690000" });
      assert.deepEqual(settlement(res, X402_HEADERS.legacyResponse), pr);

      const p = (await deps.db.getPayment(body.paymentId))!;
      assert.deepEqual([p.method, p.invoiceId, p.source, p.status], ["ausd", inv.id, "invoice", "authorized"]);
      assert.deepEqual(p.quote?.usd, money("9.69", "USD"));
      const stored = (await deps.db.getAusdRelay(p.id))!.authorization;
      assert.equal(stored.from, agent.address);
      assert.equal(stored.to, ausd.config.payTo);

      // Resending the same payment is idempotent: same payment, same receipt, nothing new.
      const again = await call(inv.code, { [X402_HEADERS.signature]: header });
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { paymentId: string }).paymentId, body.paymentId);
      assert.equal((await deps.db.listPayments("ahseng")).length, 1);
    } finally {
      await relayer.stop();
    }
  });

  test("the legacy X-PAYMENT header works too; payX402 runs the whole agent loop", async () => {
    const relayer = fakeRelayer();
    try {
      const header = await signedHeader();
      const res = await call(inv.code, { [X402_HEADERS.legacyPayment]: header });
      assert.equal(res.status, 200);

      const inv2 = await deps.db.createInvoice({
        merchantId: "ahseng",
        kind: "one_time_qr",
        lines: [{ menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 1, unit: money("5.50", "SGD") }],
        total: money("5.50", "SGD"),
      });
      const fetchVia: typeof fetch = async (input, init) => {
        const req = new Request(input as string, init);
        return handleX402Invoice(req, inv2.code, deps, ausd, FAST);
      };
      const out = await payX402(url(inv2.code), agent, { fetch: fetchVia });
      assert.equal(out.status, 200);
      assert.equal(out.paymentResponse?.success, true);
      assert.equal(out.required.accepts[0]!.amount, "4270000"); // S$5.50 / 1.29 → US$4.27
    } finally {
      await relayer.stop();
    }
  });

  test("no relayer within the wait → 202 (still relaying); resending later returns the final 200", async () => {
    const header = await signedHeader();
    const pending = await call(inv.code, { [X402_HEADERS.signature]: header }, { waitMs: 30, pollMs: 5 });
    assert.equal(pending.status, 202);
    const body = (await pending.json()) as { status: string; paymentId: string };
    assert.equal(body.status, "created");
    assert.equal(settlement(pending), null);

    const relayer = fakeRelayer();
    try {
      const done = await call(inv.code, { [X402_HEADERS.signature]: header });
      assert.equal(done.status, 200);
      assert.equal(((await done.json()) as { paymentId: string }).paymentId, body.paymentId);
    } finally {
      await relayer.stop();
    }
  });

  test("relay failure → 402 with PAYMENT-RESPONSE success:false settlement_failed", async () => {
    const relayer = fakeRelayer("failed");
    try {
      const res = await call(inv.code, { [X402_HEADERS.signature]: await signedHeader() });
      assert.equal(res.status, 402);
      assert.equal(settlement(res)?.success, false);
      assert.equal(settlement(res)?.errorReason, "settlement_failed");
    } finally {
      await relayer.stop();
    }
  });

  test("the same authorization for another invoice → 409 authorization_reused", async () => {
    const relayer = fakeRelayer();
    try {
      const header = await signedHeader();
      assert.equal((await call(inv.code, { [X402_HEADERS.signature]: header })).status, 200);
      const other = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: money("12.50", "SGD") });
      const res = await call(other.code, { [X402_HEADERS.signature]: header });
      assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [409, "authorization_reused"]);
    } finally {
      await relayer.stop();
    }
  });
});

describe("x402 · rejected payments", () => {
  async function rejected(header: string, reason: string, status = 402) {
    const res = await call(inv.code, { [X402_HEADERS.signature]: header });
    assert.equal(res.status, status);
    if (status === 402) {
      assert.equal(settlement(res)?.errorReason, reason);
      assert.equal(settlement(res)?.success, false);
      PaymentRequiredZ.parse(decodeHeader(res.headers.get(X402_HEADERS.required)!)); // fresh requirements to retry with
    } else {
      assert.equal(((await res.json()) as { error: string }).error, reason);
    }
    assert.deepEqual(await deps.db.listPayments("ahseng"), [], "nothing stored");
  }

  test("malformed headers → 400 invalid_payment (bad base64/JSON, missing fields, x402Version 1)", async () => {
    await rejected("%%%not-base64%%%", "invalid_payment", 400);
    await rejected(encodeHeader({ x402Version: 2, accepted: {} }), "invalid_payment", 400);
    const v1 = await call(inv.code, { [X402_HEADERS.signature]: encodeHeader({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} }) });
    assert.equal(v1.status, 400);
    assert.match(((await v1.json()) as { message: string }).message, /x402Version 1/);
  });

  test("tampered value or recipient, another signer, wrong network/asset → 402 with the x402 error reason", async () => {
    await rejected(await signedHeader(inv.code, (p) => (p.payload.authorization.value = "1")), "invalid_exact_evm_payload_authorization_value");
    await rejected(
      await signedHeader(inv.code, (p) => {
        p.accepted.amount = "1";
        p.payload.authorization.value = "1";
      }),
      "invalid_exact_evm_payload_authorization_value",
    );
    await rejected(await signedHeader(inv.code, (p) => (p.payload.authorization.to = agent.address)), "invalid_exact_evm_payload_recipient_mismatch");
    await rejected(await signedHeader(inv.code, (p) => (p.payload.authorization.from = testPayer().address)), "invalid_exact_evm_payload_signature");
    await rejected(await signedHeader(inv.code, (p) => (p.payload.authorization.nonce = keccak256(toHex("other")) as Hex)), "invalid_exact_evm_payload_signature");
    await rejected(await signedHeader(inv.code, (p) => (p.accepted.network = "eip155:8453")), "invalid_network");
    await rejected(await signedHeader(inv.code, (p) => (p.accepted.payTo = agent.address)), "invalid_payment_requirements");
    await rejected(await signedHeader(inv.code, (p) => (p.accepted.scheme = "upto")), "unsupported_scheme");
  });

  test("forged or expired price offer → quote_expired; no AUSD → insufficient_funds; used nonce → nonce_used", async () => {
    await rejected(await signedHeader(inv.code, (p) => (p.accepted.extra = { ...p.accepted.extra, roveQuote: "forged.token" })), "quote_expired");

    const late = await signedHeader();
    const res = await call(inv.code, { [X402_HEADERS.signature]: late }, { ...FAST, now: () => Date.now() + 20 * 60_000 });
    assert.equal(res.status, 402);
    assert.equal(settlement(res)?.errorReason, "quote_expired");

    const broke = testPayer();
    const required = await readPaymentRequired(await call(inv.code));
    await rejected(encodeHeader(await buildPaymentPayload(broke, required)), "insufficient_funds");

    const nonce = keccak256(toHex("used-nonce"));
    ausd.chain.markUsed(agent.address, nonce);
    await rejected(encodeHeader(await buildPaymentPayload(agent, required, { nonce })), "invalid_exact_evm_payload_authorization_nonce_used");
  });

  test("an invoice already being paid another way → 409 before any AUSD moves", async () => {
    const card = await deps.db.insertPayment({
      id: "pay_card_x402",
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
    const header = await signedHeader();
    await deps.db.transitionPayment(card.id, ["created"], "authorized");
    const res = await call(inv.code, { [X402_HEADERS.signature]: header });
    assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [409, "invoice_paid"]);
  });
});
