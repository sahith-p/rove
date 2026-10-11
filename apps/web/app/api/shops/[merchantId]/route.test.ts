import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ShopPublicRes } from "@rove/shared";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { clearVerifiedCache } from "../_shared";
import { get, seedMerchant, sgd, stubSettlement } from "../_testkit";
import { GET } from "./route";

const call = (merchantId: string) => GET(get(`http://web.test/api/shops/${merchantId}`), { params: Promise.resolve({ merchantId }) });

describe("GET /api/shops/:merchantId", () => {
  let deps: WebTestDeps;
  let stub: ReturnType<typeof stubSettlement>;

  beforeEach(async () => {
    clearVerifiedCache();
    stub = stubSettlement({ verified: true });
    deps = await useWebTestDeps({ settlement: stub.settlement });
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  test("live shop → ShopPublicRes with the active menu only, no-store, case-insensitive id", async () => {
    await seedMerchant(deps.db, { xrplAddress: "rAhSengTestAddress111111111" });
    await deps.db.replaceMenu("ahseng", [
      { name: "Chicken rice", price: sgd("5.50") },
      { name: "Soup of the day", price: sgd("2.00"), active: false },
      { name: "Barley drink", price: sgd("1.50") },
    ]);

    const res = await call("AhSeng");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = ShopPublicRes.parse(await res.json());
    assert.equal(body.id, "ahseng");
    assert.equal(body.name, "Ah Seng Chicken Rice");
    assert.equal(body.currency, "SGD");
    assert.equal(body.verified, true);
    assert.deepEqual(
      body.menu.map((m) => [m.name, m.price, m.active]),
      [
        ["Chicken rice", sgd("5.50"), true],
        ["Barley drink", sgd("1.50"), true],
      ],
    );
  });

  test("draft shop and unknown id → 404 shop_not_found", async () => {
    await seedMerchant(deps.db, { id: "draftshop", phone: "+6580000002", live: false });
    for (const id of ["draftshop", "nobody", "bad id!"]) {
      const res = await call(id);
      assert.equal(res.status, 404, id);
      assert.equal(((await res.json()) as { error: string }).error, "shop_not_found");
    }
  });

  test("verified is cached per merchant: two page loads, one XRPL lookup", async () => {
    await seedMerchant(deps.db, { xrplAddress: "rAhSengTestAddress111111111" });
    await seedMerchant(deps.db, { id: "kopi", phone: "+6580000003", xrplAddress: "rKopiTestAddress22222222222" });
    for (let i = 0; i < 2; i++) {
      assert.equal(ShopPublicRes.parse(await (await call("ahseng")).json()).verified, true);
      assert.equal(ShopPublicRes.parse(await (await call("kopi")).json()).verified, true);
    }
    assert.deepEqual(stub.calls.verified, ["rAhSengTestAddress111111111", "rKopiTestAddress22222222222"]);
  });

  test("engine failure → DB credential flag (issued = not verified)", async () => {
    stub.state.verified = new Error("xrpl down");
    await seedMerchant(deps.db, { xrplAddress: "rAhSengTestAddress111111111", credentialStatus: "issued" });
    assert.equal(ShopPublicRes.parse(await (await call("ahseng")).json()).verified, false);
  });
});
