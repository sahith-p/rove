import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, upsertEnvFile } from "./envfile";
import { envFileSeedStore, memorySeedStore } from "./seed-store";

test("parseEnv handles comments, quotes and empty values", () => {
  const env = parseEnv(["# c", "A=1", "B=  two  # trailing", 'C="x # y"', "D=", "export E=5", "junk line"].join("\n"));
  assert.deepEqual(env, { A: "1", B: "two", C: "x # y", D: "", E: "5" });
});

test("upsertEnvFile replaces in place, appends new keys, keeps comments, mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "rove-env-"));
  try {
    const p = join(dir, ".env.seed");
    upsertEnvFile(p, { A: "1", B: "2" }, "# header");
    upsertEnvFile(p, { B: "3", C: "4" });
    assert.equal(readFileSync(p, "utf8"), "# header\nA=1\nB=3\nC=4\n");
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("envFileSeedStore: demo merchant uses DEMO_MERCHANT_* keys, others get their own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rove-env-"));
  try {
    const p = join(dir, ".env.seed");
    const store = envFileSeedStore(p, { demoMerchantId: "ahseng" });
    await store.put("ahseng", "rAhSeng", "v1:enc-a");
    await store.put("kopi-king", "rKopi", "v1:enc-k");
    const env = parseEnv(readFileSync(p, "utf8"));
    assert.equal(env.DEMO_MERCHANT_XRPL_ADDRESS, "rAhSeng");
    assert.equal(env.DEMO_MERCHANT_SEED_ENC, "v1:enc-a");
    assert.equal(env.XRPL_MERCHANT_KOPI_KING_ADDRESS, "rKopi");
    assert.equal(await store.get("rAhSeng"), "v1:enc-a");
    assert.equal(await store.get("rKopi"), "v1:enc-k");
    assert.equal(await store.get("rNobody"), null);
    assert.equal(await store.findByMerchant?.("ahseng"), "rAhSeng");
    assert.equal(await store.findByMerchant?.("nobody"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memorySeedStore", async () => {
  const s = memorySeedStore();
  await s.put("m1", "rM1", "enc");
  assert.equal(await s.get("rM1"), "enc");
  assert.equal(await s.findByMerchant?.("m1"), "rM1");
  assert.equal(await s.get("rX"), null);
});
