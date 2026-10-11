import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSeedStore } from "./deps";
import { createMerchant, MOCK_SEED_PLACEHOLDER } from "./merchants";
import { createFakeDb, createFastSettlement } from "./test-fakes";
import { createTestDeps, TEST_CONFIG } from "./testing";

const body = {
  id: "ahseng",
  name: "Ah Seng Chicken Rice",
  phone: "+15555550100",
  channel: "imessage" as const,
  currency: "SGD" as const,
  category: "hawker",
};

describe("POST /internal/merchants (createMerchant)", () => {
  test("creates the account, goes live and emits merchant.live once", async () => {
    const fake = createFakeDb();
    const { engine, counts } = createFastSettlement();
    const deps = await createTestDeps({ db: fake.db, settlement: engine });

    const first = await createMerchant(deps, body);
    assert.equal(first.merchantId, "ahseng");
    assert.match(first.xrplAddress, /^rFAKE/);
    assert.equal(first.credentialStatus, "accepted");
    assert.equal(fake.merchants.get("ahseng")?.status, "live");
    assert.equal(fake.merchants.get("ahseng")?.credentialStatus, "accepted");
    assert.deepEqual(deps.events, [{ type: "merchant.live", merchantId: "ahseng", xrplAddress: first.xrplAddress }]);

    const second = await createMerchant(deps, body);
    assert.deepEqual(second, first);
    assert.equal(counts.createMerchantAccount, 1, "no second XRPL account");
    assert.equal(deps.events.length, 1, "no second merchant.live");
  });

  test("concurrent calls share one run", async () => {
    const fake = createFakeDb();
    const { engine, counts } = createFastSettlement();
    const deps = await createTestDeps({ db: fake.db, settlement: engine });

    const [a, b] = await Promise.all([createMerchant(deps, body), createMerchant(deps, body)]);
    assert.deepEqual(a, b);
    assert.equal(counts.createMerchantAccount, 1);
    assert.equal(deps.events.length, 1);
  });

  test("reuses the XRPL account from an interrupted earlier attempt", async () => {
    const fake = createFakeDb();
    await fake.db.upsertDraftMerchant(body);
    await fake.db.setMerchantXrpl("ahseng", { xrplAddress: "rMOCKAHSENG", xrplSeedEnc: "enc:abc", credentialStatus: "none" });
    const { engine, counts } = createFastSettlement();
    const deps = await createTestDeps({ db: fake.db, settlement: engine });

    const res = await createMerchant(deps, body);
    assert.equal(counts.createMerchantAccount, 0);
    assert.equal(res.xrplAddress, "rMOCKAHSENG");
    assert.equal(res.credentialStatus, "accepted"); // mock isVerifiedMerchant: rMOCK… → true
    assert.equal(fake.merchants.get("ahseng")?.seedEnc, "enc:abc", "seed kept");
    assert.equal(deps.events.length, 1);
  });

  test("real engine: keeps the encrypted seed the engine stored through the seed store", async () => {
    const fake = createFakeDb();
    const seeds = createSeedStore(fake.db);
    const { engine } = createFastSettlement((merchantId, address) => seeds.put(merchantId, address, "enc:secret"));
    const deps = await createTestDeps({ db: fake.db, settlement: engine, config: { ...TEST_CONFIG, useMockSettlement: false } });

    const res = await createMerchant(deps, body);
    const row = fake.merchants.get("ahseng");
    assert.equal(row?.seedEnc, "enc:secret");
    assert.equal(row?.credentialStatus, "accepted");
    assert.equal(row?.xrplAddress, res.xrplAddress);
  });

  test("real engine without a stored seed refuses to go live", async () => {
    const fake = createFakeDb();
    const { engine } = createFastSettlement();
    const deps = await createTestDeps({ db: fake.db, settlement: engine, config: { ...TEST_CONFIG, useMockSettlement: false } });

    await assert.rejects(createMerchant(deps, body), /no encrypted seed/);
    assert.equal(fake.merchants.get("ahseng")?.status, "draft");
    assert.equal(deps.events.length, 0);
  });

  test("mock engine stores a placeholder instead of a seed", async () => {
    const fake = createFakeDb();
    const { engine } = createFastSettlement();
    const deps = await createTestDeps({ db: fake.db, settlement: engine });
    await createMerchant(deps, body);
    assert.equal(fake.merchants.get("ahseng")?.seedEnc, MOCK_SEED_PLACEHOLDER);
  });

  test("a shop id owned by another phone is refused (409)", async () => {
    const fake = createFakeDb();
    await fake.db.upsertDraftMerchant({ ...body, phone: "+6591234567" });
    const deps = await createTestDeps({ db: fake.db, settlement: createFastSettlement().engine });

    await assert.rejects(createMerchant(deps, body), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "shop_id_taken");
      assert.equal((err as { status?: number }).status, 409);
      return true;
    });
  });
});
