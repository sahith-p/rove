// NI-B6 · GET /api/withdrawals/:id, on PGlite (createTestDb).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestDb } from "@rove/db/testing";
import { money, SESSION_HEADER, WithdrawalRes, type Withdrawal } from "@rove/shared";
import { setWebDepsForTests } from "../../_lib/deps";
import { sessionToken, useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { GET } from "./route";
import { DEMO_MERCHANT } from "@rove/shared/mocks";

const OWNER = "ahseng";
const OTHER = "otherco";
const WALLET = "rP4xQ7w5tTzJ3n8pX2bLm6vY1cK9sDf3Kd";
const TX = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";

type Harness = { deps: WebTestDeps; dbCalls: string[]; bankWd: Withdrawal; walletWd: Withdrawal; otherWd: Withdrawal };

let h: Harness;

async function setup(): Promise<Harness> {
  const db = await createTestDb();
  await db.upsertDraftMerchant({ id: OWNER, name: "Ah Seng Chicken Rice", phone: DEMO_MERCHANT.phone, channel: "imessage" });
  await db.upsertDraftMerchant({ id: OTHER, name: "Other Co", phone: "+15555550111", channel: "whatsapp" });
  const bank = await db.insertBankAccount({
    merchantId: OWNER,
    type: "bank_account",
    bankName: "DBS",
    last4: "1234",
    holderName: "AH SENG FOOD PTE LTD",
    beneficiaryId: "sx_bene_1",
    status: "verified",
  });
  const sgd = (a: string) => money(a, "SGD");
  const bankWd = await db.insertWithdrawal({
    merchantId: OWNER,
    amount: sgd("118.40"),
    fee: sgd("0"),
    destination: { kind: "bank", bankAccountId: bank.id },
    needsStepUp: true,
  });
  const walletWd = await db.insertWithdrawal({
    merchantId: OWNER,
    amount: sgd("5.00"),
    fee: sgd("0"),
    destination: { kind: "xrpl_wallet", address: WALLET },
    needsStepUp: false,
  });
  const otherWd = await db.insertWithdrawal({
    merchantId: OTHER,
    amount: sgd("20.00"),
    fee: sgd("0"),
    destination: { kind: "xrpl_wallet", address: WALLET },
    needsStepUp: false,
  });

  const dbCalls: string[] = [];
  const spied = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        dbCalls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const deps = await useWebTestDeps({ db: spied });
  return { deps, dbCalls, bankWd, walletWd, otherWd };
}

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => {
  await h.deps.db.close();
  setWebDepsForTests(null);
});

async function get(id: string, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers[SESSION_HEADER] = token;
  const res = await GET(new Request(`http://web.test/api/withdrawals/${id}`, { headers }), { params: Promise.resolve({ id }) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
}

const wdToken = (merchantId: string, ref: string) => sessionToken({ merchantId, scope: "withdrawal", ref });
const shopToken = (merchantId: string) => sessionToken({ merchantId, scope: "shop" });

describe("GET /api/withdrawals/:id", () => {
  test("withdrawal scope with this id → WithdrawalRes with the bank label, no-store, two queries", async () => {
    const hh = h;
    const res = await get(hh.bankWd.id, wdToken(OWNER, hh.bankWd.id));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const view = WithdrawalRes.parse(res.body);
    assert.deepEqual(view, {
      id: hh.bankWd.id,
      amount: { amount: "118.40", currency: "SGD" },
      fee: { amount: "0.00", currency: "SGD" },
      destination: { kind: "bank", label: "DBS ••••1234" },
      status: "requested",
      needsStepUp: true,
      updatedAt: hh.bankWd.updatedAt,
    });
    // The page polls this every second: one withdrawal read + one bank account read.
    assert.deepEqual(hh.dbCalls, ["getWithdrawal", "getBankAccount"]);
  });

  test("sweep tx → explorer link; bank ref and failure reason pass through", async () => {
    const hh = h;
    const { db } = hh.deps;
    await db.transitionWithdrawal(hh.bankWd.id, ["requested"], "onchain_pending", { sweepTxHash: TX });
    await db.transitionWithdrawal(hh.bankWd.id, ["onchain_pending"], "completed", { bankRef: "FAST-881245" });
    const res = await get(hh.bankWd.id, wdToken(OWNER, hh.bankWd.id));

    assert.equal(res.status, 200);
    const view = WithdrawalRes.parse(res.body);
    assert.equal(view.status, "completed");
    assert.equal(view.sweepTxHash, TX);
    assert.equal(view.explorerUrl, `https://testnet.xrpl.org/transactions/${TX}`);
    assert.equal(view.bankRef, "FAST-881245");

    await db.transitionWithdrawal(hh.walletWd.id, ["requested"], "failed", { failureReason: "XRPL tecPATH_DRY" });
    const failed = WithdrawalRes.parse((await get(hh.walletWd.id, wdToken(OWNER, hh.walletWd.id))).body);
    assert.equal(failed.failureReason, "XRPL tecPATH_DRY");
    assert.equal(failed.explorerUrl, undefined);
  });

  test("wallet destination → short address label, one query", async () => {
    const hh = h;
    const res = await get(hh.walletWd.id, wdToken(OWNER, hh.walletWd.id));
    assert.equal(res.status, 200);
    assert.deepEqual(WithdrawalRes.parse(res.body).destination, { kind: "xrpl_wallet", label: "rP4x…3Kd" });
    assert.deepEqual(hh.dbCalls, ["getWithdrawal"]);
  });

  test("the owner's shop session can read any of its withdrawals", async () => {
    const hh = h;
    for (const wd of [hh.bankWd, hh.walletWd]) {
      const res = await get(wd.id, shopToken(OWNER));
      assert.equal(res.status, 200);
      assert.equal(res.body.id, wd.id);
    }
  });

  test("another merchant's withdrawal → 404, same as an unknown id", async () => {
    const hh = h;
    const notMine = await get(hh.otherWd.id, shopToken(OWNER));
    const unknown = await get("wd_doesnotexist", shopToken(OWNER));
    assert.equal(notMine.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(notMine.body, unknown.body);
    assert.equal(notMine.body.error, "withdrawal_not_found");

    // A withdrawal-scope token naming someone else's withdrawal (wrong merchant, right ref) is a 404 too.
    const crossed = await get(hh.otherWd.id, wdToken(OWNER, hh.otherWd.id));
    assert.equal(crossed.status, 404);
    assert.deepEqual(crossed.body, unknown.body);
  });

  test("withdrawal token for a different withdrawal → 403 wrong_ref (before any lookup)", async () => {
    const hh = h;
    const res = await get(hh.walletWd.id, wdToken(OWNER, hh.bankWd.id));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "wrong_ref");
    assert.deepEqual(hh.dbCalls, []);
  });

  test("other scopes → 403; no / expired session → 401", async () => {
    const hh = h;
    for (const scope of ["bank", "setup", "sale"] as const) {
      const res = await get(hh.bankWd.id, sessionToken({ merchantId: OWNER, scope, ref: scope === "sale" ? hh.bankWd.id : undefined }));
      assert.equal(res.status, 403, scope);
      assert.equal(res.body.error, "wrong_scope");
    }
    const anon = await get(hh.bankWd.id, null);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error, "missing_session");
    const expired = await get(hh.bankWd.id, sessionToken({ merchantId: OWNER, scope: "withdrawal", ref: hh.bankWd.id, exp: Math.floor(Date.now() / 1000) - 1 }));
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error, "session_expired");
    assert.deepEqual(hh.dbCalls, []);
  });
});
