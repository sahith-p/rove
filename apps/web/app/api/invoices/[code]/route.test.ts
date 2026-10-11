import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { InvoicePublicRes } from "@rove/shared";
import { setWebDepsForTests } from "../../_lib/deps";
import { useWebTestDeps, type WebTestDeps } from "../../_lib/testing";
import { clearVerifiedCache, publicInvoiceStatus } from "../../shops/_shared";
import { get, LINES, one, seedMerchant, sgd, stubSettlement } from "../../shops/_testkit";
import { GET } from "./route";

const call = (code: string) => GET(get(`http://web.test/api/invoices/${code}`), { params: Promise.resolve({ code }) });

describe("GET /api/invoices/:code", () => {
  let deps: WebTestDeps;
  let stub: ReturnType<typeof stubSettlement>;

  beforeEach(async () => {
    clearVerifiedCache();
    stub = stubSettlement({ verified: true });
    deps = await useWebTestDeps({ settlement: stub.settlement });
    await seedMerchant(deps.db, { xrplAddress: "rAhSengTestAddress111111111", credentialStatus: "accepted" });
  });
  afterEach(async () => {
    await deps.db.close();
    setWebDepsForTests(null);
  });

  test("open invoice → InvoicePublicRes, no-store, case-insensitive code", async () => {
    const inv = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: LINES, total: sgd("12.50"), note: "Thanks!" });
    const res = await call(inv.code.toLowerCase());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = InvoicePublicRes.parse(await res.json());
    assert.deepEqual(body, {
      code: inv.code,
      kind: "invoice",
      merchant: { id: "ahseng", name: "Ah Seng Chicken Rice", verified: true },
      lines: LINES,
      total: sgd("12.50"),
      note: "Thanks!",
      status: "open",
      expiresAt: inv.expiresAt,
    });
    assert.deepEqual(stub.calls.verified, ["rAhSengTestAddress111111111"]);
  });

  test("open but past expiresAt reads as expired before the sweep runs", async () => {
    const inv = await deps.db.createInvoice({
      merchantId: "ahseng",
      kind: "one_time_qr",
      lines: one("6.50"),
      total: sgd("6.50"),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal((await deps.db.getInvoice(inv.id))?.status, "open");
    const body = InvoicePublicRes.parse(await (await call(inv.code)).json());
    assert.equal(body.status, "expired");
    assert.equal(body.kind, "one_time_qr");
    assert.equal(body.note, null);
  });

  test("paid and cancelled pass through", async () => {
    const paid = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: one("3.00"), total: sgd("3.00") });
    await deps.db.markInvoicePaid(paid.id, "pay_x");
    assert.equal(InvoicePublicRes.parse(await (await call(paid.code)).json()).status, "paid");

    const cancelled = await deps.db.createInvoice({ merchantId: "ahseng", kind: "pay_request", lines: one("4.00"), total: sgd("4.00") });
    assert.equal(await deps.db.cancelInvoice("ahseng", cancelled.code), true);
    assert.equal(InvoicePublicRes.parse(await (await call(cancelled.code)).json()).status, "cancelled");
  });

  test("unknown code → 404 invoice_not_found", async () => {
    for (const code of ["NOPE42", "%20", "X".repeat(40)]) {
      const res = await call(code);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(((await res.json()) as { error: string }).error, "invoice_not_found");
    }
  });

  test("engine failure falls back to the DB credential flag", async () => {
    stub.state.verified = new Error("xrpl down");
    const inv = await deps.db.createInvoice({ merchantId: "ahseng", kind: "invoice", lines: one("3.00"), total: sgd("3.00") });
    assert.equal(InvoicePublicRes.parse(await (await call(inv.code)).json()).merchant.verified, true); // credentialStatus accepted
  });
});

describe("publicInvoiceStatus", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  test("only open invoices expire by time", () => {
    assert.equal(publicInvoiceStatus({ status: "open", expiresAt: "2026-10-11T12:00:01Z" }, now), "open");
    assert.equal(publicInvoiceStatus({ status: "open", expiresAt: "2026-10-11T12:00:00Z" }, now), "expired");
    assert.equal(publicInvoiceStatus({ status: "paid", expiresAt: "2026-10-10T00:00:00Z" }, now), "paid");
    assert.equal(publicInvoiceStatus({ status: "cancelled", expiresAt: "2026-10-10T00:00:00Z" }, now), "cancelled");
    assert.equal(publicInvoiceStatus({ status: "expired", expiresAt: "2026-10-12T00:00:00Z" }, now), "expired");
  });
});
