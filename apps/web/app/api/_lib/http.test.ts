import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UpdateMenuReq } from "@rove/shared";
import { HttpError, json, readJson, route } from "./http";
import { nudgeWorkerSettle } from "./worker";

const read = async (res: Response) => (await res.json()) as Record<string, any>;
const put = (body: string) => new Request("http://web.test/api/me/menu", { method: "PUT", body, headers: { "content-type": "application/json" } });

describe("route()", () => {
  test("passes responses through; json() sets no-store", async () => {
    const res = await route(async () => json({ ok: true }, { status: 201 }))(put("{}"), {});
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read(res), { ok: true });
  });

  test("HttpError → its status and { error, message }", async () => {
    const res = await route(async () => {
      throw new HttpError(404, "invoice_not_found", "This payment link doesn't exist.");
    })(put("{}"), {});
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await read(res), { error: "invoice_not_found", message: "This payment link doesn't exist." });
  });

  test("ZodError → 400 invalid_body with issues", async () => {
    const handler = route(async (req) => json(await readJson(req, UpdateMenuReq)));
    const res = await handler(put(JSON.stringify({ items: [{ name: "", price: "abc" }] })), {});
    assert.equal(res.status, 400);
    const body = await read(res);
    assert.equal(body.error, "invalid_body");
    assert.ok(Array.isArray(body.issues) && body.issues.length >= 2);
  });

  test("bad JSON → 400 invalid_json", async () => {
    const res = await route(async (req) => json(await readJson(req, UpdateMenuReq)))(put("{nope"), {});
    assert.equal(res.status, 400);
    assert.equal((await read(res)).error, "invalid_json");
  });

  test("anything else → 500 internal, logged, no details leaked", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const res = await route(async () => {
        throw new Error("db password=hunter2");
      })(put("{}"), {});
      assert.equal(res.status, 500);
      const body = await read(res);
      assert.equal(body.error, "internal");
      assert.ok(!JSON.stringify(body).includes("hunter2"));
      assert.equal(logged.length, 1);
    } finally {
      console.error = original;
    }
  });

  test("readJson returns the parsed, defaulted body", async () => {
    const body = await readJson(put(JSON.stringify({ items: [{ name: "Chicken rice", price: "5.50" }] })), UpdateMenuReq);
    assert.deepEqual(body.items[0], { name: "Chicken rice", price: "5.50", active: true });
  });
});

describe("nudgeWorkerSettle", () => {
  const config = { workerUrl: "http://worker.test/", internalSecret: "s3cret" };

  test("POSTs /internal/settle with the bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok = await nudgeWorkerSettle("pay_1", {
      config,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    assert.equal(ok, true);
    assert.equal(calls[0]?.url, "http://worker.test/internal/settle");
    assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer s3cret");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { paymentId: "pay_1" });
  });

  test("never throws when the worker is down", async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const ok = await nudgeWorkerSettle("pay_1", {
        config,
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      });
      assert.equal(ok, false);
    } finally {
      console.warn = original;
    }
  });
});
