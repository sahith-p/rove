import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MeRes, UpdateMenuReq } from "@rove/shared";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { get, put, seedMerchant, sgd, token } from "../../shops/_testkit";
import { GET as getMe } from "../route";
import { PUT } from "./route";

const call = (body: unknown, session?: string) => PUT(put("http://web.test/api/me/menu", body, session), {});
const setup = () => token({ merchantId: "ahseng", scope: "setup" });

describe("PUT /api/me/menu", () => {
  let deps: WebTestDeps;

  beforeEach(async () => {
    deps = await useWebTestDeps();
    await seedMerchant(deps.db, { live: false });
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  test("setup scope replaces the menu → 204, prices as Money, shop.updated [menu]", async () => {
    const res = await call(
      {
        items: [
          { name: "Chicken rice", price: "5.5" },
          { name: " Barley drink ", price: "1.50", active: true },
          { name: "Soup", price: "2", active: false },
        ],
      },
      setup(),
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const menu = await deps.db.listMenu("ahseng", { includeInactive: true });
    assert.deepEqual(
      menu.map((m) => [m.name, m.price, m.active]),
      [
        ["Chicken rice", sgd("5.50"), true],
        ["Barley drink", sgd("1.50"), true],
        ["Soup", sgd("2.00"), false],
      ],
    );
    assert.deepEqual(deps.events, [{ type: "shop.updated", merchantId: "ahseng", fields: ["menu"] }]);
  });

  test("round trip with the setup page: GET /api/me ids come back in the PUT and are kept", async () => {
    await deps.db.replaceMenu("ahseng", [
      { name: "Chicken rice", price: sgd("5.50") },
      { name: "Barley drink", price: sgd("1.50") },
    ]);
    const me = MeRes.parse(await (await getMe(get("http://web.test/api/me", setup()), {})).json());
    // What SetupApp sends: existing ids, a renamed item, a removed item, a new one.
    const body = UpdateMenuReq.parse({
      items: [
        { id: me.menu[0]!.id, name: "Roasted chicken rice", price: "6.00", active: true },
        { name: "Kopi", price: "1.80", active: true },
      ],
    });
    assert.equal((await call(body, setup())).status, 204);
    const after = await deps.db.listMenu("ahseng", { includeInactive: true });
    const roasted = after.find((m) => m.name === "Roasted chicken rice");
    assert.equal(roasted?.id, me.menu[0]!.id, "an edited item keeps its id");
    assert.deepEqual(
      (await deps.db.listMenu("ahseng")).map((m) => m.name),
      ["Roasted chicken rice", "Kopi"],
    );
    assert.equal(after.find((m) => m.name === "Barley drink"), undefined, "an item removed in the setup card is deleted");
  });

  test("bank / shop / sale scopes can't touch the menu → 403, nothing emitted", async () => {
    for (const scope of ["bank", "shop", "sale", "withdrawal"] as const) {
      const res = await call({ items: [{ name: "Free food", price: "0.01" }] }, token({ merchantId: "ahseng", scope, ref: "x" }));
      assert.equal(res.status, 403, scope);
    }
    assert.equal((await call({ items: [] })).status, 401);
    assert.deepEqual(await deps.db.listMenu("ahseng", { includeInactive: true }), []);
    assert.deepEqual(deps.events, []);
  });

  test("bad prices, blank or duplicate names → 400 with a code the page can show", async () => {
    const cases: [unknown, string][] = [
      [{ items: [{ name: "Rice", price: "1.234" }] }, "invalid_price"],
      [{ items: [{ name: "Rice", price: "0" }] }, "invalid_price"],
      [{ items: [{ name: "Rice", price: "0.00" }] }, "invalid_price"],
      [{ items: [{ name: "   ", price: "1.00" }] }, "invalid_item"],
      [{ items: [{ name: "Rice", price: "1.00" }, { name: "rice ", price: "2.00" }] }, "duplicate_item"],
      [{ items: [{ name: "Rice", price: "-1" }] }, "invalid_body"],
      [{ items: [{ name: "Rice", price: 1.5 }] }, "invalid_body"],
    ];
    for (const [body, code] of cases) {
      const res = await call(body, setup());
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(((await res.json()) as { error: string }).error, code, JSON.stringify(body));
    }
    assert.deepEqual(deps.events, []);
  });

  test("an empty menu is allowed (everything deactivated)", async () => {
    await deps.db.replaceMenu("ahseng", [{ name: "Chicken rice", price: sgd("5.50") }]);
    assert.equal((await call({ items: [] }, setup())).status, 204);
    assert.deepEqual(await deps.db.listMenu("ahseng"), []);
    assert.deepEqual(deps.events, [{ type: "shop.updated", merchantId: "ahseng", fields: ["menu"] }]);
  });
});
