import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "@rove/shared";
import type { MenuItem, PendingAction, Withdrawal, WithdrawalStatus } from "@rove/shared";
import { DEMO_MENU, DEMO_MERCHANT, demoInvoice, demoPayment } from "@rove/shared/mocks";
import { createCardBuilders, WITHDRAWAL_STATUS_LABEL } from "./builders";

const BASE = "https://rove.example";
const cards = createCardBuilders({ baseUrl: BASE });
const T = "sess.tok-123";
const CT = "confirm.tok-456";
const T0 = "2026-10-11T00:00:00.000Z";

// demoInvoice/demoPayment stamp Date.now(); pin the timestamps so specs compare deterministically.
const invoice = (o: Parameters<typeof demoInvoice>[0] = {}) =>
  demoInvoice({ createdAt: T0, expiresAt: T0, ...o });
const payment = (o: Parameters<typeof demoPayment>[0] = {}) =>
  demoPayment({ createdAt: T0, updatedAt: T0, ...o });

function withdrawal(o: Partial<Withdrawal> = {}): Withdrawal {
  return {
    id: "wd_demo0001",
    merchantId: "ahseng",
    amount: money("50.00", "SGD"),
    fee: money("0", "SGD"),
    destination: { kind: "bank", bankAccountId: "bank_1" },
    status: "requested",
    needsStepUp: false,
    createdAt: T0,
    updatedAt: T0,
    ...o,
  };
}

function action(o: Partial<PendingAction> = {}): PendingAction {
  return {
    id: "act_demo0001",
    merchantId: "ahseng",
    kind: "refund",
    args: { kind: "refund", paymentId: "pay_demo0001", amount: money("12.50", "SGD"), reason: "wrong order" },
    status: "proposed",
    confirmMessageIds: [],
    expiresAt: T0,
    createdAt: T0,
    ...o,
  };
}

const parse = (url: string) => new URL(url);

// ------------------------------------------------------------------ keys + URL shapes

test("setup: key, url, v = active item count", () => {
  const spec = cards.setup({ merchant: DEMO_MERCHANT, menu: DEMO_MENU, sessionToken: T });
  assert.equal(spec.kind, "setup");
  assert.equal(spec.key, "setup:ahseng");
  assert.equal(spec.live, true);
  const u = parse(spec.url);
  assert.equal(u.origin, BASE);
  assert.equal(u.pathname, "/setup");
  assert.equal(u.searchParams.get("t"), T);
  assert.equal(u.searchParams.get("v"), "4");
  assert.equal(spec.fallbackText, "Set up Ah Seng Chicken Rice: add your menu and details here.");
  assert.equal(spec.updateText, undefined);
});

test("setup/menu: v counts only active items", () => {
  const menu: MenuItem[] = DEMO_MENU.map((m, i) => (i < 2 ? { ...m, active: false } : m));
  const setup = cards.setup({ merchant: DEMO_MERCHANT, menu, sessionToken: T });
  const menuCard = cards.menu({ merchant: DEMO_MERCHANT, menu });
  assert.equal(parse(setup.url).searchParams.get("v"), "2");
  assert.equal(parse(menuCard.url).searchParams.get("v"), "2");
  assert.equal(parse(cards.menu({ merchant: DEMO_MERCHANT, menu: [] }).url).searchParams.get("v"), "0");
});

test("bank: key, url, no v", () => {
  const spec = cards.bank({ merchant: DEMO_MERCHANT, sessionToken: T });
  assert.equal(spec.key, "bank:ahseng");
  const u = parse(spec.url);
  assert.equal(u.pathname, "/bank");
  assert.equal(u.searchParams.get("t"), T);
  assert.equal(u.searchParams.has("v"), false);
  assert.equal(spec.fallbackText, "Add your bank account so you can withdraw (secure form, link valid 15 min).");
  assert.equal(spec.updateText, undefined);
});

test("shop: key, url", () => {
  const spec = cards.shop({ merchant: DEMO_MERCHANT, sessionToken: T });
  assert.equal(spec.key, "shop:ahseng");
  const u = parse(spec.url);
  assert.equal(u.pathname, "/shop");
  assert.equal(u.searchParams.get("t"), T);
  assert.equal(spec.fallbackText, "Ah Seng Chicken Rice: balance, payments, invoices and menu.");
  assert.equal(spec.updateText, undefined);
});

test("menu: key, url /m/<id>", () => {
  const spec = cards.menu({ merchant: DEMO_MERCHANT, menu: DEMO_MENU });
  assert.equal(spec.key, "menu:ahseng");
  const u = parse(spec.url);
  assert.equal(u.pathname, "/m/ahseng");
  assert.equal(u.searchParams.get("v"), "4");
  assert.equal(u.searchParams.has("t"), false);
  assert.equal(spec.fallbackText, "Ah Seng Chicken Rice menu: tap to order and pay.");
});

test("invoice: key, url, S$ text, note, v + updateText on paid only", () => {
  const open = cards.invoice({ invoice: invoice(), merchant: DEMO_MERCHANT });
  assert.equal(open.key, "invoice:inv_demo0001");
  const u = parse(open.url);
  assert.equal(u.pathname, "/pay/K7Q2MX");
  assert.equal(u.searchParams.get("v"), "open");
  assert.equal(open.fallbackText, "Ah Seng Chicken Rice sent you a request for S$12.50.");
  assert.equal(open.updateText, undefined);
  assert.equal("updateText" in open, false);

  const noted = cards.invoice({ invoice: invoice({ note: "table 4" }), merchant: DEMO_MERCHANT });
  assert.equal(noted.fallbackText, "Ah Seng Chicken Rice sent you a request for S$12.50. Note: table 4");

  const paid = cards.invoice({ invoice: invoice({ status: "paid" }), merchant: DEMO_MERCHANT });
  assert.equal(paid.key, open.key);
  assert.equal(parse(paid.url).searchParams.get("v"), "paid");
  assert.notEqual(paid.url, open.url);
  assert.equal(paid.updateText, "Paid ✓ S$12.50 to Ah Seng Chicken Rice.");

  for (const status of ["expired", "cancelled"] as const) {
    assert.equal(cards.invoice({ invoice: invoice({ status }), merchant: DEMO_MERCHANT }).updateText, undefined);
  }
});

test("receipt: key, url, updateText only on refunds", () => {
  const settled = cards.receipt({ payment: payment(), merchant: DEMO_MERCHANT });
  assert.equal(settled.key, "receipt:pay_demo0001");
  const u = parse(settled.url);
  assert.equal(u.pathname, "/r/pay_demo0001");
  assert.equal(u.searchParams.get("v"), "settled");
  assert.equal(u.searchParams.has("view"), false);
  assert.equal(settled.fallbackText, "Receipt: S$12.50 paid to Ah Seng Chicken Rice.");
  assert.equal(settled.updateText, undefined);

  const refunded = cards.receipt({
    payment: payment({ status: "refunded", refunded: money("12.50", "SGD") }),
    merchant: DEMO_MERCHANT,
  });
  assert.equal(parse(refunded.url).searchParams.get("v"), "refunded");
  assert.equal(refunded.updateText, "Ah Seng Chicken Rice refunded S$12.50.");

  const partial = cards.receipt({
    payment: payment({ status: "partially_refunded", refunded: money("5.5", "SGD") }),
    merchant: DEMO_MERCHANT,
  });
  assert.equal(partial.updateText, "Ah Seng Chicken Rice refunded S$5.50.");
});

test("sale: key, merchant view url with token, payer fallback", () => {
  const spec = cards.sale({ payment: payment(), merchant: DEMO_MERCHANT, sessionToken: T });
  assert.equal(spec.key, "sale:pay_demo0001");
  const u = parse(spec.url);
  assert.equal(u.pathname, "/r/pay_demo0001");
  assert.equal(u.searchParams.get("view"), "merchant");
  assert.equal(u.searchParams.get("t"), T);
  assert.equal(u.searchParams.get("v"), "settled");
  assert.equal(spec.fallbackText, "S$12.50 from +15555550199 ✓");
  assert.equal(spec.updateText, undefined);

  const anon = cards.sale({ payment: payment({ payer: null }), merchant: DEMO_MERCHANT, sessionToken: T });
  assert.equal(anon.fallbackText, "S$12.50 from a customer ✓");

  const refunded = cards.sale({
    payment: payment({ status: "partially_refunded", refunded: money("6.00", "SGD") }),
    merchant: DEMO_MERCHANT,
    sessionToken: T,
  });
  assert.equal(parse(refunded.url).searchParams.get("v"), "partially_refunded");
  assert.equal(refunded.updateText, "Refunded S$6.00.");
});

test("withdrawal: key, url, v per status, status labels", () => {
  const statuses = Object.keys(WITHDRAWAL_STATUS_LABEL) as WithdrawalStatus[];
  const urls = new Set<string>();
  for (const status of statuses) {
    const spec = cards.withdrawal({
      withdrawal: withdrawal({ status }),
      merchant: DEMO_MERCHANT,
      destinationLabel: "DBS ••••1234",
      sessionToken: T,
    });
    assert.equal(spec.key, "withdrawal:wd_demo0001");
    const u = parse(spec.url);
    assert.equal(u.pathname, "/w/wd_demo0001");
    assert.equal(u.searchParams.get("t"), T);
    assert.equal(u.searchParams.get("v"), status);
    assert.equal(spec.fallbackText, `Withdrawal of S$50.00 to DBS ••••1234: ${WITHDRAWAL_STATUS_LABEL[status]}.`);
    urls.add(spec.url);
  }
  assert.equal(urls.size, statuses.length);
});

test("withdrawal: updateText only on completed / failed / returned", () => {
  const build = (o: Partial<Withdrawal>) =>
    cards.withdrawal({ withdrawal: withdrawal(o), merchant: DEMO_MERCHANT, destinationLabel: "DBS ••••1234", sessionToken: T });

  assert.equal(build({ status: "completed", bankRef: "FAST-881245" }).updateText, "In your bank ✓ S$50.00 · FAST-881245");
  assert.equal(build({ status: "completed" }).updateText, "In your bank ✓ S$50.00 ·");
  assert.equal(build({ status: "failed", failureReason: "name mismatch" }).updateText,
    "Withdrawal failed: name mismatch. Money is back in your balance.");
  assert.equal(build({ status: "failed" }).updateText, "Withdrawal failed: unknown. Money is back in your balance.");
  assert.equal(build({ status: "returned" }).updateText, "Bank returned the withdrawal. S$50.00 is back in your balance.");
  assert.equal(
    build({ status: "completed", destination: { kind: "xrpl_wallet", address: "rTest" } }).updateText,
    "Sent S$50.00 to your wallet ✓",
  );

  for (const status of ["requested", "approved", "onchain_pending", "onchain_settled", "payout_pending", "cancelled"] as const) {
    const spec = build({ status });
    assert.equal(spec.updateText, undefined, status);
    assert.equal("updateText" in spec, false, status);
  }
});

test("confirm: key, url with confirm token, updateText on done / expired / failed", () => {
  const summary = "Refund S$12.50 to +15555550199";
  const build = (status: PendingAction["status"]) =>
    cards.confirm({ action: action({ status }), merchant: DEMO_MERCHANT, summary, confirmToken: CT });

  const proposed = build("proposed");
  assert.equal(proposed.key, "confirm:act_demo0001");
  const u = parse(proposed.url);
  assert.equal(u.pathname, "/confirm/act_demo0001");
  assert.equal(u.searchParams.get("t"), CT);
  assert.equal(u.searchParams.get("v"), "proposed");
  assert.equal(proposed.fallbackText, `${summary} — tap to confirm.`);

  assert.equal(build("done").updateText, `Done ✓ ${summary}`);
  assert.equal(build("expired").updateText, `Expired: ${summary}. Ask me again.`);
  assert.equal(build("failed").updateText, `Failed: ${summary}.`);
  for (const status of ["proposed", "executing", "cancelled"] as const) {
    assert.equal(build(status).updateText, undefined, status);
  }
  assert.notEqual(build("done").url, proposed.url);
});

// ------------------------------------------------------------------ cross-cutting

test("all builders are live and deterministic (same input → identical spec)", () => {
  const all = (c: ReturnType<typeof createCardBuilders>) => [
    c.setup({ merchant: DEMO_MERCHANT, menu: DEMO_MENU, sessionToken: T }),
    c.bank({ merchant: DEMO_MERCHANT, sessionToken: T }),
    c.shop({ merchant: DEMO_MERCHANT, sessionToken: T }),
    c.menu({ merchant: DEMO_MERCHANT, menu: DEMO_MENU }),
    c.invoice({ invoice: invoice({ status: "paid" }), merchant: DEMO_MERCHANT }),
    c.receipt({ payment: payment(), merchant: DEMO_MERCHANT }),
    c.sale({ payment: payment(), merchant: DEMO_MERCHANT, sessionToken: T }),
    c.withdrawal({ withdrawal: withdrawal({ status: "completed" }), merchant: DEMO_MERCHANT, destinationLabel: "PayNow", sessionToken: T }),
    c.confirm({ action: action(), merchant: DEMO_MERCHANT, summary: "Withdraw S$50.00", confirmToken: CT }),
  ];
  const a = all(cards);
  const b = all(cards);
  const c = all(createCardBuilders({ baseUrl: BASE }));
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.length, 9);
  assert.equal(new Set(a.map((s) => s.kind)).size, 9);
  for (const spec of a) {
    assert.equal(spec.live, true);
    assert.ok(spec.url.startsWith(`${BASE}/`), spec.url);
  }
});

test("baseUrl with and without trailing slash yields identical URLs", () => {
  const slash = createCardBuilders({ baseUrl: `${BASE}/` });
  const pairs = [
    [cards.setup({ merchant: DEMO_MERCHANT, menu: DEMO_MENU, sessionToken: T }), slash.setup({ merchant: DEMO_MERCHANT, menu: DEMO_MENU, sessionToken: T })],
    [cards.menu({ merchant: DEMO_MERCHANT, menu: DEMO_MENU }), slash.menu({ merchant: DEMO_MERCHANT, menu: DEMO_MENU })],
    [cards.invoice({ invoice: invoice(), merchant: DEMO_MERCHANT }), slash.invoice({ invoice: invoice(), merchant: DEMO_MERCHANT })],
    [cards.sale({ payment: payment(), merchant: DEMO_MERCHANT, sessionToken: T }), slash.sale({ payment: payment(), merchant: DEMO_MERCHANT, sessionToken: T })],
  ];
  for (const [a, b] of pairs) {
    assert.ok(a && b);
    assert.equal(a.url, b.url);
    assert.ok(!a.url.includes("//", "https://".length), a.url);
  }
});
