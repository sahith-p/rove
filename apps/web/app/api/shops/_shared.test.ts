import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { InvoicePublicRes } from "@rove/shared";
import { route } from "../_lib/http";
import { clearVerifiedCache, merchantVerified, respond, VERIFIED_TIMEOUT_MS, VERIFIED_TTL_MS } from "./_shared";
import { stubSettlement } from "./_testkit";

const merchant = (o: Partial<{ id: string; xrplAddress: string | null; credentialStatus: "none" | "issued" | "accepted" }> = {}) => ({
  id: "ahseng",
  xrplAddress: "rAhSengTestAddress111111111",
  credentialStatus: "accepted" as const,
  ...o,
});

describe("merchantVerified", () => {
  beforeEach(() => clearVerifiedCache());

  test("asks the engine once per merchant per 60s", async () => {
    const stub = stubSettlement({ verified: true });
    const t0 = 1_000_000;
    assert.equal(await merchantVerified(stub, merchant(), t0), true);
    stub.state.verified = false; // a change on XRPL isn't seen until the entry expires
    assert.equal(await merchantVerified(stub, merchant(), t0 + VERIFIED_TTL_MS - 1), true);
    assert.equal(stub.calls.verified.length, 1);
    assert.equal(await merchantVerified(stub, merchant(), t0 + VERIFIED_TTL_MS), false);
    assert.equal(stub.calls.verified.length, 2);
    // another merchant has its own entry
    assert.equal(await merchantVerified(stub, merchant({ id: "kopi", xrplAddress: "rKopi" }), t0), false);
    assert.equal(stub.calls.verified.length, 3);
  });

  test("engine error → DB flag, not cached (next call retries XRPL)", async () => {
    const stub = stubSettlement({ verified: new Error("connection refused") });
    assert.equal(await merchantVerified(stub, merchant({ credentialStatus: "accepted" }), 1), true);
    assert.equal(await merchantVerified(stub, merchant({ credentialStatus: "issued" }), 2), false);
    stub.state.verified = true;
    assert.equal(await merchantVerified(stub, merchant({ credentialStatus: "issued" }), 3), true);
    assert.equal(stub.calls.verified.length, 3);
  });

  test("no XRPL account yet → DB flag without calling the engine", async () => {
    const stub = stubSettlement({ verified: true });
    assert.equal(await merchantVerified(stub, merchant({ xrplAddress: null, credentialStatus: "none" })), false);
    assert.equal(stub.calls.verified.length, 0);
  });

  test(`a hung engine call → DB flag after ${VERIFIED_TIMEOUT_MS}ms`, async () => {
    const stub = stubSettlement({ verified: "hang" });
    const t = Date.now();
    assert.equal(await merchantVerified(stub, merchant({ credentialStatus: "accepted" })), true);
    assert.ok(Date.now() - t >= VERIFIED_TIMEOUT_MS - 50);
  });
});

describe("respond", () => {
  test("a body that breaks its contract is a 500, never a 400 or a leak", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = await route(async () => respond(InvoicePublicRes, { code: "X" } as never))(new Request("http://web.test/x"), {});
      assert.equal(res.status, 500);
      assert.deepEqual(Object.keys((await res.json()) as object).sort(), ["error", "message"]);
    } finally {
      console.error = original;
    }
  });
});
