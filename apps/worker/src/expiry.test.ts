import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money } from "@rove/shared";
import type { WorkerDeps } from "./deps";
import { expireOnce, startExpiryJob } from "./expiry";
import { authorizedPayment, createKit, liveMerchant, MAYA, NO_TEST_DB, testDbAvailable } from "./settle/testkit";

const dbReady = await testDbAvailable();
const skip = dbReady ? false : NO_TEST_DB;

const past = () => new Date(Date.now() - 60_000).toISOString();
const line = { menuItemId: null, name: "Chicken rice", qty: 1, unit: money("5.50", "SGD") };

const invoice = (deps: WorkerDeps, kind: "invoice" | "one_time_qr" | "pay_request", expiresAt?: string) =>
  deps.db.createInvoice({ merchantId: "ahseng", kind, to: kind === "one_time_qr" ? null : MAYA, lines: [line], total: money("5.50", "SGD"), expiresAt });

describe("invoice expiry", { skip }, () => {
  test("expires open invoices and QR codes past expires_at, leaves the rest", async (t) => {
    const { deps, logs } = await createKit(t);
    await liveMerchant(deps);
    const oldInvoice = await invoice(deps, "invoice", past());
    const oldQr = await invoice(deps, "one_time_qr", past());
    const fresh = await invoice(deps, "invoice");

    const r = await expireOnce(deps);

    assert.deepEqual(r, { count: 2, byKind: { invoice: 1, one_time_qr: 1 } });
    assert.equal((await deps.db.getInvoice(oldInvoice.id))?.status, "expired");
    assert.equal((await deps.db.getInvoice(oldQr.id))?.status, "expired");
    assert.equal((await deps.db.getInvoice(fresh.id))?.status, "open");
    assert.ok(logs.some((l) => l.includes("expired invoices") && l.includes(oldQr.code)));

    assert.deepEqual(await expireOnce(deps), { count: 0, byKind: {} }, "second pass: nothing left");
  });

  test("an invoice being paid (payment authorized) isn't expired under the customer", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    const inv = await invoice(deps, "invoice", past());
    await authorizedPayment(deps, { invoiceId: inv.id, local: "5.50" });

    assert.equal((await expireOnce(deps)).count, 0);
    assert.equal((await deps.db.getInvoice(inv.id))?.status, "open");
  });

  test("startExpiryJob runs on its interval; the stopper stops it", async (t) => {
    const { deps } = await createKit(t);
    await liveMerchant(deps);
    const stop = startExpiryJob(deps);
    t.after(stop);
    const inv = await invoice(deps, "pay_request", past());
    const until = Date.now() + 3000;
    while ((await deps.db.getInvoice(inv.id))?.status !== "expired") {
      assert.ok(Date.now() < until, "timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    stop();
    const later = await invoice(deps, "pay_request", past());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await deps.db.getInvoice(later.id))?.status, "open");
  });
});
