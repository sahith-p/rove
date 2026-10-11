import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_HEADER, signToken } from "@rove/shared";
import { HttpError } from "./http";
import { optionalSession, requireSession } from "./session";
import { sessionToken } from "./testing";

const req = (token?: string) => new Request("http://web.test/api/me", { headers: token ? { [SESSION_HEADER]: token } : {} });

function expectHttp(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe("requireSession", () => {
  test("accepts a valid token with an allowed scope", () => {
    const s = requireSession(req(sessionToken({ merchantId: "ahseng", scope: "setup" })), ["setup"]);
    assert.equal(s.merchantId, "ahseng");
    assert.equal(s.scope, "setup");
  });

  test("401 when missing, tampered or signed with another secret", () => {
    expectHttp(() => requireSession(req(), ["shop"]), 401, "missing_session");
    const good = sessionToken({ merchantId: "ahseng", scope: "shop" });
    const [body, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ merchantId: "other", scope: "shop", exp: 9999999999 })).toString("base64url");
    expectHttp(() => requireSession(req(`${forged}.${sig}`), ["shop"]), 401, "invalid_session");
    expectHttp(() => requireSession(req(`${body}.AAAA`), ["shop"]), 401, "invalid_session");
    expectHttp(() => requireSession(req("garbage"), ["shop"]), 401, "invalid_session");
    const otherSecret = signToken({ merchantId: "ahseng", scope: "shop", exp: 9999999999 }, "not-the-secret");
    expectHttp(() => requireSession(req(otherSecret), ["shop"]), 401, "invalid_session");
  });

  test("401 session_expired for an expired but genuine token", () => {
    const expired = sessionToken({ merchantId: "ahseng", scope: "setup", exp: Math.floor(Date.now() / 1000) - 1 });
    expectHttp(() => requireSession(req(expired), ["setup"]), 401, "session_expired");
  });

  test("403 wrong_scope", () => {
    const bank = sessionToken({ merchantId: "ahseng", scope: "bank" });
    expectHttp(() => requireSession(req(bank), ["setup"]), 403, "wrong_scope");
  });

  test("ref: object scopes must match, broad scopes pass (route checks ownership)", () => {
    const wd = sessionToken({ merchantId: "ahseng", scope: "withdrawal", ref: "wd_1" });
    assert.equal(requireSession(req(wd), ["withdrawal", "shop"], { ref: "wd_1" }).ref, "wd_1");
    expectHttp(() => requireSession(req(wd), ["withdrawal", "shop"], { ref: "wd_2" }), 403, "wrong_ref");

    const noRef = sessionToken({ merchantId: "ahseng", scope: "withdrawal" });
    expectHttp(() => requireSession(req(noRef), ["withdrawal"], { ref: "wd_1" }), 403, "wrong_ref");

    const shop = sessionToken({ merchantId: "ahseng", scope: "shop" });
    assert.equal(requireSession(req(shop), ["withdrawal", "shop"], { ref: "wd_1" }).scope, "shop");
  });
});

describe("optionalSession", () => {
  test("payload for a valid token, null otherwise", () => {
    const sale = sessionToken({ merchantId: "ahseng", scope: "sale", ref: "pay_1" });
    assert.equal(optionalSession(req(sale))?.ref, "pay_1");
    assert.equal(optionalSession(req(sale), ["shop"]), null);
    assert.equal(optionalSession(req()), null);
    assert.equal(optionalSession(req("garbage")), null);
    assert.equal(optionalSession(req(sessionToken({ merchantId: "ahseng", scope: "sale", exp: 1 }))), null);
  });
});
