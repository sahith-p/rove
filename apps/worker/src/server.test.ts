import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SettlementEngine } from "@rove/shared";
import { UserFacingError } from "./errors";
import { createLogger } from "./log";
import { createServer } from "./server";
import { createFakeDb, createFastSettlement } from "./test-fakes";
import { createTestDeps, TEST_CONFIG, TEST_INTERNAL_SECRET } from "./testing";

const read = async (res: Response) => (await res.json()) as Record<string, any>;

const auth = { authorization: `Bearer ${TEST_INTERNAL_SECRET}`, "content-type": "application/json" };
const merchantBody = { id: "ahseng", name: "Ah Seng Chicken Rice", phone: "+15555550100", channel: "imessage", currency: "SGD", category: null } as const;

async function app(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const fake = createFakeDb();
  const deps = await createTestDeps({ db: fake.db, settlement: createFastSettlement().engine, ...overrides });
  return { server: createServer(deps), deps, fake };
}

const post = (path: string, body: unknown, headers: Record<string, string> = auth) => ({
  method: "POST",
  headers,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("auth", () => {
  test("/healthz is public", async () => {
    const { server } = await app();
    const res = await server.request("/healthz");
    assert.equal(res.status, 200);
    assert.equal((await read(res)).ok, true);
  });

  test("rejects a missing or wrong bearer token", async () => {
    const { server, deps } = await app();
    for (const headers of [{ "content-type": "application/json" }, { ...auth, authorization: "Bearer nope" }, { ...auth, authorization: TEST_INTERNAL_SECRET }]) {
      const res = await server.request("/internal/merchants", post("/internal/merchants", merchantBody, headers));
      assert.equal(res.status, 401);
      assert.equal((await read(res)).error, "unauthorized");
    }
    assert.equal(deps.events.length, 0);
  });

  test("an empty INTERNAL_SECRET accepts nothing", async () => {
    const { server } = await app({ config: { ...TEST_CONFIG, internalSecret: "" } });
    const res = await server.request("/internal/merchants", post("/internal/merchants", merchantBody, { ...auth, authorization: "Bearer " }));
    assert.equal(res.status, 401);
  });

  test("unknown internal routes still need auth", async () => {
    const { server } = await app();
    assert.equal((await server.request("/internal/nope", { method: "POST" })).status, 401);
    assert.equal((await server.request("/internal/nope", post("/internal/nope", {}))).status, 404);
  });
});

describe("validation", () => {
  test("invalid JSON → 400 invalid_json", async () => {
    const { server } = await app();
    const res = await server.request("/internal/merchants", post("/internal/merchants", "{not json"));
    assert.equal(res.status, 400);
    assert.equal((await read(res)).error, "invalid_json");
  });

  test("schema violations → 400 invalid_body with issues", async () => {
    const { server, deps } = await app();
    const res = await server.request("/internal/merchants", post("/internal/merchants", { ...merchantBody, id: "Bad Id!", phone: "123" }));
    assert.equal(res.status, 400);
    const json = await read(res);
    assert.equal(json.error, "invalid_body");
    const paths = (json.issues as { path: string[] }[]).map((i) => i.path.join("."));
    assert.ok(paths.includes("id") && paths.includes("phone"), `issues: ${paths}`);
    assert.equal(deps.events.length, 0);
  });

  test("every contract route validates its body", async () => {
    const { server } = await app();
    const routes: [string, string][] = [
      ["POST", "/internal/settle"],
      ["POST", "/internal/refunds"],
      ["POST", "/internal/withdrawals"],
      ["POST", "/internal/withdrawals/wd_1/execute"],
      ["POST", "/internal/merchants"],
      ["PATCH", "/internal/merchants/ahseng/auto-withdraw"],
    ];
    for (const [method, path] of routes) {
      const res = await server.request(path, { method, headers: auth, body: JSON.stringify({ bogus: true }) });
      assert.equal(res.status, 400, `${method} ${path}`);
    }
  });
});

describe("error mapping", () => {
  test("stubbed handlers answer 501 not_implemented", async () => {
    const { server } = await app();
    const res = await server.request("/internal/settle", post("/internal/settle", { paymentId: "pay_1" }));
    assert.equal(res.status, 501);
    const json = await read(res);
    assert.equal(json.error, "not_implemented");
    assert.equal(typeof json.message, "string");
  });

  test("UserFacingError → { error: code, message } with its status (default 422)", async () => {
    const throwing: SettlementEngine = {
      ...createFastSettlement().engine,
      createMerchantAccount: async () => {
        throw new UserFacingError("xrpl_busy", "The ledger is busy. Try again in a minute.");
      },
    };
    const { server } = await app({ settlement: throwing });
    const res = await server.request("/internal/merchants", post("/internal/merchants", merchantBody));
    assert.equal(res.status, 422);
    assert.deepEqual(await read(res), { error: "xrpl_busy", message: "The ledger is busy. Try again in a minute." });
  });

  test("custom status passes through (409 for a taken shop id)", async () => {
    const { server, fake } = await app();
    await fake.db.upsertDraftMerchant({ ...merchantBody, phone: "+6591234567", channel: "imessage" });
    const res = await server.request("/internal/merchants", post("/internal/merchants", merchantBody));
    assert.equal(res.status, 409);
    assert.equal((await read(res)).error, "shop_id_taken");
  });

  test("other errors → 500 internal, logged, no details leaked", async () => {
    const lines: string[] = [];
    const log = createLogger("test", { level: "error", sink: (_l, line) => lines.push(line) });
    const crashing: SettlementEngine = {
      ...createFastSettlement().engine,
      createMerchantAccount: async () => {
        throw new Error("tefPAST_SEQ secret-detail");
      },
    };
    const { server } = await app({ settlement: crashing, log });
    const res = await server.request("/internal/merchants", post("/internal/merchants", merchantBody));
    assert.equal(res.status, 500);
    const json = await read(res);
    assert.equal(json.error, "internal");
    assert.ok(!JSON.stringify(json).includes("secret-detail"));
    assert.ok(lines.some((l) => l.includes("handler crashed") && l.includes("tefPAST_SEQ")));
  });
});

describe("POST /internal/merchants over HTTP", () => {
  test("returns InternalCreateMerchantRes and is idempotent", async () => {
    const { server, deps } = await app();
    const a = await server.request("/internal/merchants", post("/internal/merchants", merchantBody));
    const b = await server.request("/internal/merchants", post("/internal/merchants", merchantBody));
    assert.equal(a.status, 200);
    const ja = await read(a);
    assert.deepEqual(await read(b), ja);
    assert.equal(ja.merchantId, "ahseng");
    assert.equal(ja.credentialStatus, "accepted");
    assert.deepEqual(
      deps.events.map((e) => e.type),
      ["merchant.live"],
    );
  });
});
