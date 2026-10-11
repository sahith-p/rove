import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mnemonicToAccount } from "viem/accounts";
import { createTestDb } from "@rove/db/testing";
import { CheckoutRes, money, type InvoiceLine, type Recipient } from "@rove/shared";
import { DEPOSIT_ACCOUNT_PATH } from "../_lib/bsc";
import { setWebDepsForTests } from "../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../_lib/testing";
import { createFakeStripe, type FakeStripe } from "../stripe/fake-stripe";
import { bnbPaymentId, depositIndexOf } from "./bnb";
import { POST } from "./route";

// createTestDb({ demo: true }): live merchant "ahseng" (SGD menu). Mock settlement: 1.2900 SGD per USD → S$12.50 = US$9.69.
// Deposit index sequence starts at 1 (0 is left for the collector), so the first payment gets m/44'/60'/0'/0/1.

const MNEMONIC = "test test test test test test test test test test test junk";
const XPUB = mnemonicToAccount(MNEMONIC, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().publicExtendedKey;
/** What the worker derives from the mnemonic (it can sweep these). */
const workerAddress = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i }).address;
const TOKEN = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";

const MAYA: Recipient = { phone: "+15555550199", channel: "imessage" };
const SG_PAYER: Recipient = { phone: "+6591234567", channel: "whatsapp" };
const LINES: InvoiceLine[] = [
  { menuItemId: "item_chicken_rice", name: "Chicken rice", qty: 2, unit: money("5.50", "SGD") },
  { menuItemId: "item_barley", name: "Barley drink", qty: 1, unit: money("1.50", "SGD") },
];
const BSC_ENV = { BSC_DEPOSIT_XPUB: XPUB, BSC_TOKEN_ADDRESS: TOKEN, BSC_TOKEN_DECIMALS: "18" } as const;

let deps: WebTestDeps;
let fake: FakeStripe;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(Object.keys(BSC_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, BSC_ENV);
  fake = createFakeStripe();
  deps = await useWebTestDeps({ db: await createTestDb({ demo: true }), stripe: fake.client });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setWebDepsForTests(null);
  await deps.db.close();
});

async function checkout(body: unknown) {
  const res = await POST(
    new Request("http://web.test/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    {},
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function ok(body: unknown) {
  const r = await checkout(body);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return CheckoutRes.parse(r.body);
}

async function expectError(body: unknown, status: number, code: string) {
  const r = await checkout(body);
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.error, code);
}

function invoice(opts: { to?: Recipient | null } = {}) {
  return deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", to: opts.to === undefined ? MAYA : opts.to, lines: LINES, total: money("12.50", "SGD") });
}

const byCode = (code: string, extra: Record<string, unknown> = {}) => ({ target: { source: "invoice", code }, method: "bnb", ...extra });
const shop = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  target: { source: "fixed_qr", merchantId: "ahseng", ...target },
  method: "bnb",
  ...extra,
});

describe("POST /api/checkout · method bnb", () => {
  test("invoice: USD charge = quote.usd, a fresh deposit address, the payment row carries it", async () => {
    const inv = await invoice({ to: SG_PAYER }); // a +65 payer would get SGD on the card lane; bnb is always USD
    const res = await ok(byCode(inv.code, { payCurrency: "SGD" }));

    assert.deepEqual(res.local, money("12.50", "SGD"));
    assert.deepEqual(res.quote.usd, money("9.69", "USD"));
    assert.deepEqual(res.charge, money("9.69", "USD"));
    assert.equal(res.stripe, undefined);
    assert.deepEqual(res.bnb, { chainId: 97, depositAddress: workerAddress(1), token: TOKEN, decimals: 18, amount: "9.69" });
    assert.equal(fake.calls.create.length, 0, "no Stripe on this lane");

    const p = await deps.db.getPayment(res.paymentId);
    assert.ok(p);
    assert.equal(p.status, "created");
    assert.equal(p.method, "bnb");
    assert.equal(p.source, "invoice");
    assert.equal(p.invoiceId, inv.id);
    assert.deepEqual(p.charge, money("9.69", "USD"));
    assert.deepEqual(p.lines, LINES);
    assert.deepEqual(p.payer, SG_PAYER);
    assert.equal(p.stripePaymentIntentId, undefined);
    assert.equal(depositIndexOf(p.id), 1);
    // insertPayment stored bnbDepositAddress: the watcher finds the payment by it (any case)
    assert.equal((await deps.db.getPaymentByDepositAddress(workerAddress(1)))?.id, p.id);
    assert.equal((await deps.db.getPaymentByDepositAddress(workerAddress(1).toLowerCase()))?.id, p.id);
  });

  test("works without Stripe configured", async () => {
    setWebDepsForTests({ ...deps, stripe: null });
    const res = await ok(byCode((await invoice()).code));
    assert.ok(res.bnb);
  });

  test("reuse: the same invoice hands back the same payment and address; no new index is used", async () => {
    const inv = await invoice();
    const a = await ok(byCode(inv.code));
    const b = await ok(byCode(inv.code));
    assert.equal(b.paymentId, a.paymentId);
    assert.equal(b.bnb?.depositAddress, a.bnb?.depositAddress);
    assert.equal(b.quote.expiresAt, a.quote.expiresAt);
    assert.deepEqual(b.charge, a.charge);
    // the next new payment takes index 2: the reuse didn't burn one
    const other = await ok(byCode((await invoice()).code));
    assert.equal(other.bnb?.depositAddress, workerAddress(2));
    assert.equal(depositIndexOf(other.paymentId), 2);
  });

  test("reuse is per method: a card payment for the same invoice isn't handed to the wallet, and vice versa", async () => {
    const inv = await invoice();
    const card = await ok({ ...byCode(inv.code), method: "card", payCurrency: "USD" });
    const bnb = await ok(byCode(inv.code));
    assert.notEqual(bnb.paymentId, card.paymentId);
    assert.ok(bnb.bnb && !bnb.stripe);
    const card2 = await ok({ ...byCode(inv.code), method: "card", payCurrency: "USD" });
    assert.equal(card2.paymentId, card.paymentId);
    assert.equal((await ok(byCode(inv.code))).paymentId, bnb.paymentId);
  });

  test("an expired (or nearly expired) quote is not reused: new payment, new address", async () => {
    const inv = await invoice();
    const old = await ok(byCode(inv.code));
    await deps.db.transitionPayment(old.paymentId, ["created"], "created", {
      quote: { ...old.quote, expiresAt: new Date(Date.now() + 2000).toISOString() },
    });
    const fresh = await ok(byCode(inv.code));
    assert.notEqual(fresh.paymentId, old.paymentId);
    assert.notEqual(fresh.bnb?.depositAddress, old.bnb?.depositAddress);
    assert.equal(fresh.bnb?.depositAddress, workerAddress(2));
  });

  test("a rotated xpub: the old payment's address can't be re-derived, so a new payment is made", async () => {
    const inv = await invoice();
    const old = await ok(byCode(inv.code));
    const other = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    process.env.BSC_DEPOSIT_XPUB = mnemonicToAccount(other, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().publicExtendedKey;
    const fresh = await ok(byCode(inv.code));
    assert.notEqual(fresh.paymentId, old.paymentId);
    assert.equal(fresh.bnb?.depositAddress, mnemonicToAccount(other, { addressIndex: 2 }).address);
  });

  test("an invoice already authorized (e.g. by an earlier deposit) → 409 invoice_paid", async () => {
    const inv = await invoice();
    const a = await ok(byCode(inv.code));
    assert.ok(await deps.db.transitionPayment(a.paymentId, ["created"], "authorized", { payinTxHash: "0xabc" }));
    await expectError(byCode(inv.code), 409, "invoice_paid");
  });

  test("fixed QR: same basket + phone reused; another basket gets its own address", async () => {
    const items = [
      { menuItemId: "item_chicken_rice", qty: 1 },
      { menuItemId: "item_egg", qty: 2 },
    ];
    const a = await ok(shop({ items }, { payerPhone: MAYA.phone }));
    const b = await ok(shop({ items: [...items].reverse() }, { payerPhone: MAYA.phone }));
    assert.equal(b.paymentId, a.paymentId);
    assert.equal(b.bnb?.depositAddress, a.bnb?.depositAddress);
    const c = await ok(shop({ amount: "7.00" }));
    assert.deepEqual(c.local, money("7.00", "SGD"));
    assert.deepEqual(c.charge, money("5.43", "USD")); // ceil(700 / 1.29) cents
    assert.equal(c.bnb?.amount, "5.43");
    const addrs = new Set([a.bnb?.depositAddress, c.bnb?.depositAddress]);
    assert.equal(addrs.size, 2);
  });

  test("target errors still come first (404 / 409 / 400)", async () => {
    await expectError(byCode("ZZZZZZ"), 404, "invoice_not_found");
    await expectError(shop({ amount: "500.01" }), 400, "amount_over_limit");
  });

  test("lane not configured → 503 bnb_not_configured, nothing written, no index used", async () => {
    delete process.env.BSC_DEPOSIT_XPUB;
    const inv = await invoice();
    await expectError(byCode(inv.code), 503, "bnb_not_configured");
    assert.deepEqual(await deps.db.listPayments("ahseng"), []);
    process.env.BSC_DEPOSIT_XPUB = XPUB;
    assert.equal((await ok(byCode(inv.code))).bnb?.depositAddress, workerAddress(1));
  });

  test("an xprv in BSC_DEPOSIT_XPUB is refused (500), never used", async () => {
    process.env.BSC_DEPOSIT_XPUB = mnemonicToAccount(MNEMONIC, { path: DEPOSIT_ACCOUNT_PATH }).getHdKey().privateExtendedKey;
    const inv = await invoice();
    const r = await checkout(byCode(inv.code));
    assert.equal(r.status, 500);
    assert.deepEqual(await deps.db.listPayments("ahseng"), []);
  });
});

describe("bnb payment ids", () => {
  test("carry the deposit index", () => {
    for (const i of [1, 2, 99, 123456789]) {
      const id = bnbPaymentId(i);
      assert.match(id, /^pay_[0-9a-f]{32}_bsc\d+$/);
      assert.equal(depositIndexOf(id), i);
    }
    assert.equal(depositIndexOf("pay_0123456789abcdef0123456789abcdef"), null);
    assert.equal(depositIndexOf("pay_b17"), null);
  });
});
