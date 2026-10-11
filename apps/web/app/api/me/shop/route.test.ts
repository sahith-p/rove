import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { put, seedMerchant, token } from "../../shops/_testkit";
import { PUT } from "./route";

const call = (body: unknown, session?: string) => PUT(put("http://web.test/api/me/shop", body, session), {});
const setup = () => token({ merchantId: "ahseng", scope: "setup" });

describe("PUT /api/me/shop", () => {
  let deps: WebTestDeps;

  beforeEach(async () => {
    deps = await useWebTestDeps();
    await seedMerchant(deps.db, { live: false }); // name "Ah Seng Chicken Rice", category "hawker", SGD
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  test("setup scope saves → 204 and shop.updated names only the fields that changed", async () => {
    const res = await call({ name: "  Ah Seng Kopi  ", category: "cafe", currency: "SGD" }, setup());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const m = await deps.db.getMerchant("ahseng");
    assert.equal(m?.name, "Ah Seng Kopi");
    assert.equal(m?.category, "cafe");
    assert.deepEqual(deps.events, [{ type: "shop.updated", merchantId: "ahseng", fields: ["name", "category"] }]);
  });

  test("saving the same values again → 204, no event", async () => {
    assert.equal((await call({ name: "Ah Seng Chicken Rice", category: "hawker", currency: "SGD" }, setup())).status, 204);
    assert.equal((await call({}, setup())).status, 204);
    assert.deepEqual(deps.events, []);
  });

  test("an empty category clears it", async () => {
    assert.equal((await call({ category: "  " }, setup())).status, 204);
    assert.equal((await deps.db.getMerchant("ahseng"))?.category, null);
    assert.deepEqual(deps.events, [{ type: "shop.updated", merchantId: "ahseng", fields: ["category"] }]);
  });

  test("other scopes → 403, no session → 401; nothing changes, nothing emitted", async () => {
    for (const scope of ["shop", "bank", "sale", "withdrawal"] as const) {
      const res = await call({ name: "Hacked" }, token({ merchantId: "ahseng", scope, ref: "x" }));
      assert.equal(res.status, 403, scope);
      assert.equal(((await res.json()) as { error: string }).error, "wrong_scope");
    }
    assert.equal((await call({ name: "Hacked" })).status, 401);
    assert.equal((await deps.db.getMerchant("ahseng"))?.name, "Ah Seng Chicken Rice");
    assert.deepEqual(deps.events, []);
  });

  test("invalid bodies → 400", async () => {
    for (const body of [{ name: "A" }, { name: "  A  " }, { currency: "USD" }, { category: "x".repeat(41) }, "not json"]) {
      const res = await call(body, setup());
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(deps.events, []);
  });

  test("a session for a shop that no longer exists → 404", async () => {
    const res = await call({ name: "Ghost Shop" }, token({ merchantId: "ghost", scope: "setup" }));
    assert.equal(res.status, 404);
  });
});
