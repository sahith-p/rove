// NI-B6 · POST /api/me/bank-accounts, on PGlite (createTestDb) with the mock payout partner.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Db } from "@rove/db";
import { createTestDb } from "@rove/db/testing";
import { AddBankAccountRes, SESSION_HEADER, TOKEN_TTL_SEC, type BeneficiaryInput, type PayoutPartner } from "@rove/shared";
import { createMockPayoutPartner } from "@rove/shared/mocks";
import { setWebDepsForTests } from "../../_lib/deps";
import { sessionToken, useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { POST } from "./route";

const MERCHANT = "ahseng";

type Harness = {
  deps: WebTestDeps;
  /** Every Db call the route made, with its arguments. */
  dbCalls: unknown[][];
  /** What the payout partner was sent. */
  partnerCalls: BeneficiaryInput[];
  /** Everything written to console.* while requests ran. */
  logs: string[];
};

let h: Harness;

async function setup(payouts: PayoutPartner = createMockPayoutPartner(20)): Promise<Harness> {
  const db = await createTestDb();
  await db.upsertDraftMerchant({ id: MERCHANT, name: "Ah Seng Chicken Rice", phone: "+15555550100", channel: "imessage" });
  await db.upsertDraftMerchant({ id: "otherco", name: "Other Co", phone: "+15555550111", channel: "whatsapp" });
  const dbCalls: unknown[][] = [];
  const partnerCalls: BeneficiaryInput[] = [];
  const spiedPayouts: PayoutPartner = {
    ...payouts,
    createBeneficiary: async (input) => {
      partnerCalls.push(input);
      return payouts.createBeneficiary(input);
    },
  };
  const deps = await useWebTestDeps({ db: spyDb(db, dbCalls), payouts: spiedPayouts });
  return { deps, dbCalls, partnerCalls, logs: [] };
}

function spyDb(db: Db, calls: unknown[][]): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => {
  await h.deps.db.close();
  setWebDepsForTests(null);
});

async function post(body: unknown, opts: { token?: string | null; raw?: string } = {}) {
  const token = opts.token === undefined ? sessionToken({ merchantId: MERCHANT, scope: "bank" }) : opts.token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers[SESSION_HEADER] = token;
  const req = new Request("http://web.test/api/me/bank-accounts", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });

  // Capture every console line the request produces.
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  methods.forEach((m) => {
    console[m] = (...args: unknown[]) => void h.logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  try {
    const res = await POST(req, {});
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  } finally {
    methods.forEach((m, i) => (console[m] = original[i]!));
  }
}

/** The raw number (and its digits-only form) must not appear in anything we keep or say. */
async function assertNowhere(hh: Harness, raws: string[], responseText: string) {
  const stored = JSON.stringify(await hh.deps.db.listBankAccounts(MERCHANT));
  const dbArgs = JSON.stringify(hh.dbCalls);
  const events = JSON.stringify(hh.deps.envelopes);
  const logs = hh.logs.join("\n");
  for (const raw of raws) {
    assert.ok(!stored.includes(raw), `bank_accounts rows contain ${raw}`);
    assert.ok(!dbArgs.includes(raw), `a Db call was given ${raw}`);
    assert.ok(!responseText.includes(raw), `response contains ${raw}`);
    assert.ok(!events.includes(raw), `emitted event contains ${raw}`);
    assert.ok(!logs.includes(raw), `logs contain ${raw}`);
  }
}

describe("POST /api/me/bank-accounts", () => {
  test("bank account: partner gets the number, we keep last4 + resolved name, emit the label", async () => {
    const hh = h;
    const accountNumber = "0123456789";
    const res = await post({ type: "bank_account", bankName: "DBS", accountNumber, holderName: "  Ah Seng   Food Pte Ltd " });

    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const view = AddBankAccountRes.parse(res.body);
    assert.deepEqual(
      { type: view.type, bankName: view.bankName, last4: view.last4, holderName: view.holderName, status: view.status, isDefault: view.isDefault },
      { type: "bank_account", bankName: "DBS", last4: "6789", holderName: "AH SENG FOOD PTE LTD", status: "verified", isDefault: true },
    );

    assert.equal(hh.partnerCalls.length, 1);
    assert.equal(hh.partnerCalls[0]!.accountNumber, accountNumber);
    assert.equal(hh.partnerCalls[0]!.bankName, "DBS");
    assert.equal(hh.partnerCalls[0]!.holderName, "Ah Seng Food Pte Ltd");

    const [row] = await hh.deps.db.listBankAccounts(MERCHANT);
    assert.equal(row?.id, view.id);
    assert.equal(row?.last4, "6789");
    assert.match(row?.beneficiaryId ?? "", /^sx_bene_/);

    assert.deepEqual(hh.deps.events, [
      { type: "bank_account.added", merchantId: MERCHANT, bankAccountId: view.id, label: "DBS ••••6789 (AH SENG FOOD PTE LTD)" },
    ]);
    await assertNowhere(hh, [accountNumber], res.text);
  });

  test("PayNow UEN: proxy to the partner, no bank name, 'PayNow' label", async () => {
    const hh = h;
    const uen = "201912345K";
    const res = await post({ type: "paynow_uen", uen, holderName: "Ah Seng Food Pte Ltd" });

    assert.equal(res.status, 201);
    const view = AddBankAccountRes.parse(res.body);
    assert.equal(view.type, "paynow_uen");
    assert.equal(view.bankName, null);
    assert.equal(view.last4.length, 4);
    assert.deepEqual(hh.partnerCalls[0], { merchantId: MERCHANT, type: "paynow_uen", proxy: uen, holderName: "Ah Seng Food Pte Ltd" });
    assert.equal(hh.deps.events[0]?.type, "bank_account.added");
    assert.equal((hh.deps.events[0] as { label: string }).label, `PayNow ••••${view.last4} (AH SENG FOOD PTE LTD)`);
    await assertNowhere(hh, [uen, "201912345"], res.text);
  });

  test("PayNow mobile: proxy to the partner, last4 of the number", async () => {
    const hh = h;
    const mobile = "+6591234567";
    const res = await post({ type: "paynow_mobile", mobile, holderName: "Tan Ah Seng" });

    assert.equal(res.status, 201);
    const view = AddBankAccountRes.parse(res.body);
    assert.deepEqual({ type: view.type, bankName: view.bankName, last4: view.last4 }, { type: "paynow_mobile", bankName: null, last4: "4567" });
    assert.equal(hh.partnerCalls[0]?.proxy, mobile);
    assert.equal((hh.deps.events[0] as { label: string }).label, "PayNow ••••4567 (TAN AH SENG)");
    await assertNowhere(hh, [mobile, "6591234567", "91234567"], res.text);
  });

  test("the first account becomes default; later ones don't", async () => {
    const hh = h;
    const first = await post({ type: "bank_account", bankName: "DBS", accountNumber: "0123456789", holderName: "Ah Seng" });
    const second = await post({ type: "paynow_mobile", mobile: "+6591234567", holderName: "Ah Seng" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body?.isDefault, true);
    assert.equal(second.body?.isDefault, false);
    assert.equal((await hh.deps.db.getDefaultBankAccount(MERCHANT))?.id, first.body?.id);
    assert.equal(hh.deps.events.length, 2);
  });

  test("wrong scope → 403, no session → 401; the partner is never called", async () => {
    const hh = h;
    const body = { type: "bank_account", bankName: "DBS", accountNumber: "0123456789", holderName: "Ah Seng" };
    for (const scope of ["shop", "setup", "withdrawal"] as const) {
      const res = await post(body, { token: sessionToken({ merchantId: MERCHANT, scope, ref: scope === "withdrawal" ? "wd_x" : undefined }) });
      assert.equal(res.status, 403, scope);
      assert.equal(res.body?.error, "wrong_scope");
    }
    const anon = await post(body, { token: null });
    assert.equal(anon.status, 401);
    assert.equal(anon.body?.error, "missing_session");
    assert.equal(hh.partnerCalls.length, 0);
    assert.deepEqual(await hh.deps.db.listBankAccounts(MERCHANT), []);
    assert.deepEqual(hh.deps.events, []);
  });

  test("a bank link older than its 15-minute TTL → 401 session_expired", async () => {
    const hh = h;
    const issued = Math.floor(Date.now() / 1000) - 16 * 60;
    const token = sessionToken({ merchantId: MERCHANT, scope: "bank", exp: issued + TOKEN_TTL_SEC.bank });
    const res = await post({ type: "paynow_uen", uen: "201912345K", holderName: "Ah Seng" }, { token });
    assert.equal(res.status, 401);
    assert.equal(res.body?.error, "session_expired");
    assert.equal(hh.partnerCalls.length, 0);
    assert.deepEqual(await hh.deps.db.listBankAccounts(MERCHANT), []);
  });

  test("partner says failed → 422 with a readable message; nothing stored or emitted", async () => {
    await h.deps.db.close();
    const failing: PayoutPartner = {
      ...createMockPayoutPartner(20),
      createBeneficiary: async () => ({ beneficiaryId: "sx_bene_bad", resolvedName: "", nameMatches: false, status: "failed", last4: "6789" }),
    };
    const hh = (h = await setup(failing));
    const accountNumber = "0123456789";
    const res = await post({ type: "bank_account", bankName: "OCBC", accountNumber, holderName: "Ah Seng" });

    assert.equal(res.status, 422);
    assert.equal(res.body?.error, "account_not_verified");
    assert.match(res.body?.message, /couldn't verify this account/);
    assert.equal(hh.partnerCalls.length, 1);
    assert.deepEqual(await hh.deps.db.listBankAccounts(MERCHANT), []);
    assert.ok(!hh.dbCalls.some(([m]) => m === "insertBankAccount"));
    assert.deepEqual(hh.deps.events, []);
    await assertNowhere(hh, [accountNumber], res.text);
  });

  test("partner error that quotes the number → 502; the log line is scrubbed", async () => {
    await h.deps.db.close();
    const accountNumber = "0123456789";
    const broken: PayoutPartner = {
      ...createMockPayoutPartner(20),
      createBeneficiary: async (input) => {
        throw new Error(`upstream 500: account ${input.accountNumber} (0123-456-789) rejected`);
      },
    };
    const hh = (h = await setup(broken));
    const res = await post({ type: "bank_account", bankName: "UOB", accountNumber, holderName: "Ah Seng" });

    assert.equal(res.status, 502);
    assert.equal(res.body?.error, "partner_unavailable");
    assert.equal(hh.logs.length, 1);
    assert.match(hh.logs[0]!, /payout partner error for ahseng/);
    assert.deepEqual(await hh.deps.db.listBankAccounts(MERCHANT), []);
    await assertNowhere(hh, [accountNumber, "0123-456-789"], res.text);
  });

  test("validation errors name the field but never echo the value", async () => {
    const hh = h;
    const tooLong = "98765432109876543210";
    const res = await post({ type: "bank_account", bankName: "DBS", accountNumber: tooLong, holderName: "Ah Seng" });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_body");
    assert.equal(res.body?.message, "Check the account number, then try again.");
    assert.deepEqual(res.body?.issues, [{ path: ["accountNumber"], code: "invalid_string" }]);

    const badMobile = await post({ type: "paynow_mobile", mobile: "91234567", holderName: "Ah Seng" });
    assert.equal(badMobile.status, 400);
    assert.ok(!badMobile.text.includes("91234567"));

    const badType = await post({ type: "iban", accountNumber: tooLong, holderName: "x" });
    assert.equal(badType.status, 400);
    assert.ok(!badType.text.includes("iban"));

    assert.equal(hh.partnerCalls.length, 0);
    await assertNowhere(hh, [tooLong], res.text + badType.text);
  });

  test("a number typed into the name or bank field is refused before it goes anywhere", async () => {
    const hh = h;
    const inName = await post({ type: "paynow_uen", uen: "201912345K", holderName: "Ah Seng 0123456789" });
    assert.equal(inName.status, 400);
    assert.deepEqual(inName.body?.issues, [{ path: ["holderName"], code: "invalid_name" }]);
    const inBank = await post({ type: "bank_account", bankName: "DBS 0123 456 789", accountNumber: "0123456789", holderName: "Ah Seng" });
    assert.equal(inBank.status, 400);
    assert.deepEqual(inBank.body?.issues, [{ path: ["bankName"], code: "invalid_bank" }]);
    const blankBank = await post({ type: "bank_account", bankName: "  ", accountNumber: "0123456789", holderName: "Ah Seng" });
    assert.equal(blankBank.status, 400);
    assert.equal(hh.partnerCalls.length, 0);
    await assertNowhere(hh, ["0123456789", "0123 456 789"], inName.text + inBank.text + blankBank.text);
  });

  test("a session for a merchant that doesn't exist → 404, partner not called", async () => {
    const hh = h;
    const res = await post(
      { type: "paynow_uen", uen: "201912345K", holderName: "Ah Seng" },
      { token: sessionToken({ merchantId: "ghost", scope: "bank" }) },
    );
    assert.equal(res.status, 404);
    assert.equal(hh.partnerCalls.length, 0);
  });

  test("bad JSON → 400 invalid_json", async () => {
    const hh = h;
    const res = await post(null, { raw: "{accountNumber: 0123456789" });
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "invalid_json");
    assert.ok(!res.text.includes("0123456789"));
  });
});
