// Real end-to-end money path (gate G3 minus the phones). Owner: Nithya · Task: NI-C7.
//
//   pnpm --filter worker exec tsx scripts/e2e-smoke.ts [merchantId=ahseng] [--no-withdrawal]
//   (from a worktree without its own .env: ROVE_DOTENV=/path/to/rove/.env pnpm --filter worker exec tsx …)
//
// REAL Supabase DB (DATABASE_URL), REAL Stripe sandbox (sk_test_ only), REAL XRPL testnet; USE_MOCK_SETTLEMENT is
// forced to 0 for this run. Payouts use the mock partner (simulated StraitsX, as in the demo).
//   1. invoice S$12.50 (2 × Chicken rice + 1 × Barley drink, prices from the DB menu) via @rove/db
//   2. POST /api/checkout (the web route handler, in-process) with payCurrency USD → real PaymentIntent
//   3. confirm it with pm_card_visa through the Stripe API
//   4. POST /api/stripe/webhook with payment_intent.succeeded, signed with STRIPE_WEBHOOK_SECRET exactly as Stripe signs
//      (Stripe-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<raw body>")))
//   5. the worker's settlePayment → XRPL
//   6. assert: payment settled, invoice paid, ledger payment_credit S$12.50, the XRPL tx delivered exactly 12.50 XSGD
//      (meta.delivered_amount), reconcileMerchant ok
//   7. bank account via POST /api/me/bank-accounts (mock partner), then a S$5.00 bank withdrawal through the real
//      pipeline (createWithdrawal → executeWithdrawal → sweep on XRPL → simulated payout) → ledger and XRPL still agree
// Events are recorded in memory, not stored or sent: the real agent must not text the demo phones about a test sale.
// The worker nudge from the webhook goes nowhere (WORKER_URL is pointed at a closed port): this script settles itself.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getDb } from "@rove/db";
import {
  add,
  format,
  fromMinor,
  money,
  signToken,
  sub,
  toMinor,
  type InvoiceLine,
  type MerchantId,
  type MerchantSessionPayload,
  type Money,
  type WithdrawalStatus,
} from "@rove/shared";
import { DEMO_CUSTOMER } from "@rove/shared/mocks";
import { plainDecimal } from "@rove/xrpl";
import { installMoneyLog } from "../src/boot";
import { reconcileMerchant, type ReconcileResult } from "../src/reconcile";
import { invoiceIdHex, settlePayment } from "../src/settle";
import { createWithdrawal } from "../src/withdrawals/create";
import { executeWithdrawal } from "../src/withdrawals/execute";
import { idle } from "../src/withdrawals/lock";
import { startPartnerCallbacks } from "../src/withdrawals/partner";
import { assertTestnet, fetchTx, liveWorker, loadEnv, need, recordingEmitter, short, type LiveWorker } from "./_lib";

const args = process.argv.slice(2);
const merchantId = (args.find((a) => !a.startsWith("--")) ?? "ahseng") as MerchantId;
const withWithdrawal = !args.includes("--no-withdrawal");
const FINAL: WithdrawalStatus[] = ["completed", "failed", "returned", "cancelled"];
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
const step = (msg: string) => console.log(`\n${at()}  ${msg}`);
const ok = (msg: string) => console.log(`         ✓ ${msg}`);
const evidence: string[] = [];

// ------------------------------------------------------------------ env (before any module reads it)

const envFile = loadEnv();
process.env.USE_MOCK_SETTLEMENT = "0";
process.env.USE_MOCK_PAYOUTS = "1";
process.env.WORKER_URL = "http://127.0.0.1:9"; // the webhook's settle nudge fails fast; step 5 settles in-process
const wss = assertTestnet();
const stripeKey = need("STRIPE_SECRET_KEY");
if (!stripeKey.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)");
const webhookSecret = need("STRIPE_WEBHOOK_SECRET");
need("DATABASE_URL");

// The web route modules read their deps through getWebDeps(); import them after the env is final.
const { createWebDeps, setWebDepsForTests } = await import("../../web/app/api/_lib/deps");
const { POST: checkoutPOST } = await import("../../web/app/api/checkout/route");
const { POST: webhookPOST } = await import("../../web/app/api/stripe/webhook/route");
const { POST: bankPOST } = await import("../../web/app/api/me/bank-accounts/route");

// ------------------------------------------------------------------ helpers

/** Stripe-Signature for `payload`, computed exactly as Stripe does (scheme v1). */
function stripeSignature(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

async function ledgerRows(live: LiveWorker, ref: string): Promise<{ kind: string; amount: string; currency: string }[]> {
  return live.sql.query(`select kind, amount::text as amount, currency from ledger_entries where ref = $1 order by created_at, kind`, [ref]);
}

/** delivered_amount of a validated tx, checked to be the merchant's stablecoin from our issuer. */
async function delivered(live: LiveWorker, hash: string, currency: Money["currency"]) {
  const tx = await fetchTx(live.engine, hash);
  const meta = tx.meta as Record<string, any>;
  const d = meta.delivered_amount as { currency: string; issuer: string; value: string } | string;
  const asset = live.engine.context.asset(currency);
  assert.equal(meta.TransactionResult, "tesSUCCESS", `${hash}: ${meta.TransactionResult}`);
  assert.equal(typeof d, "object", "delivered_amount is a token amount");
  const dd = d as { currency: string; issuer: string; value: string };
  assert.equal(dd.currency, asset.currency, "delivered currency");
  assert.equal(dd.issuer, asset.issuer, "delivered issuer");
  const json = (tx.tx_json ?? tx) as Record<string, any>;
  return { amount: money(plainDecimal(dd.value), currency), destination: String(json.Destination), account: String(json.Account), validated: tx.validated === true };
}

function describeRec(r: ReconcileResult): string {
  return `ledger ${format(r.ledger)} (available ${format(r.available)}, held ${format(r.held)}) vs XRPL ${r.onchain ? format(r.onchain) : "?"} → ${r.status}`;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log(`e2e-smoke · ${merchantId} · DB: Supabase (DATABASE_URL) · Stripe: sandbox · XRPL: ${wss} · payouts: mock (simulated StraitsX)`);
  console.log(`          env: ${envFile ? "env file + environment" : "environment only"} · USE_MOCK_SETTLEMENT=0 forced`);

  const live = liveWorker({ db: getDb(), scope: "e2e" });
  installMoneyLog(live.deps);
  const webRec = recordingEmitter();
  // The web routes get the real web deps (read-only XRPL engine for quotes, Stripe, webhook secret) but share the
  // worker's Db and record their events. (apps/web resolves its own copy of @rove/db, so its pool is closed unused.)
  const web = createWebDeps();
  if (web.db !== live.db) await web.db.close();
  setWebDepsForTests({ ...web, db: live.db, emit: webRec.emit });
  const stripe = web.stripe!;

  try {
    // 0. preconditions
    const merchant = await live.db.getMerchant(merchantId);
    assert.ok(merchant, `merchant ${merchantId} not found (pnpm --filter @rove/db seed:demo)`);
    assert.equal(merchant.status, "live", "merchant is live");
    assert.ok(merchant.xrplAddress, "merchant has a custodial XRPL account");
    const address = merchant.xrplAddress;
    const cur = merchant.currency;
    const before = await reconcileMerchant(live.deps, merchantId);
    step(`before: ${describeRec(before)}`);
    assert.ok(before.ok, "ledger and XRPL agree before the run (run scripts/demo-reset.ts on a fresh demo merchant)");

    // 1. invoice from DB prices
    step("1. invoice S$12.50 from the DB menu");
    const [rice, barley] = await live.db.findMenuItems(merchantId, ["Chicken rice", "Barley drink"]);
    assert.ok(rice?.item && barley?.item, "demo menu has Chicken rice and Barley drink");
    const lines: InvoiceLine[] = [
      { menuItemId: rice.item.id, name: rice.item.name, qty: 2, unit: rice.item.price },
      { menuItemId: barley.item.id, name: barley.item.name, qty: 1, unit: barley.item.price },
    ];
    const total = lines.reduce<Money>((sum, l) => add(sum, fromMinor(toMinor(l.unit) * BigInt(l.qty), l.unit.currency)), money("0", cur));
    assert.equal(format(total), "S$12.50", "2 × Chicken rice + 1 × Barley drink");
    const invoice = await live.db.createInvoice({
      merchantId,
      kind: "invoice",
      to: { phone: DEMO_CUSTOMER.phone, channel: DEMO_CUSTOMER.channel },
      lines,
      total,
      note: "e2e smoke (NI-C7)",
    });
    ok(`invoice ${invoice.code} · ${lines.map((l) => `${l.qty} × ${l.name} ${format(l.unit)}`).join(" + ")} = ${format(invoice.total)}`);

    // 2. checkout (web route, in-process)
    step("2. POST /api/checkout { invoice, card, payCurrency: USD }");
    const res = await checkoutPOST(
      new Request("http://web.local/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: { source: "invoice", code: invoice.code }, method: "card", payCurrency: "USD" }),
      }),
      {},
    );
    const co = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200, JSON.stringify(co));
    const paymentId = co.paymentId as string;
    const created = (await live.db.getPayment(paymentId))!;
    const piId = created.stripePaymentIntentId!;
    ok(`payment ${paymentId} · charge ${format(co.charge)} for ${format(co.local)} (rate ${co.quote.rate}, quote expires ${co.quote.expiresAt}) · ${piId}`);

    // 3. confirm with a test card
    step("3. confirm the PaymentIntent with pm_card_visa");
    const confirmed = await stripe.paymentIntents.confirm(piId, { payment_method: "pm_card_visa", return_url: "https://example.com/rove-e2e" });
    assert.equal(confirmed.status, "succeeded");
    assert.equal(confirmed.metadata.paymentId, paymentId);
    ok(`${piId} succeeded · ${confirmed.amount} ${confirmed.currency}`);

    // 4. webhook, signed like Stripe
    step("4. POST /api/stripe/webhook payment_intent.succeeded (Stripe-Signature v1 with STRIPE_WEBHOOK_SECRET)");
    const payload = JSON.stringify({
      id: `evt_e2e_${paymentId}`,
      object: "event",
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "payment_intent.succeeded",
      data: { object: confirmed },
    });
    const hook = await webhookPOST(
      new Request("http://web.local/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": stripeSignature(payload, webhookSecret) }, body: payload }),
      {},
    );
    const hookBody = (await hook.json()) as { outcome?: string };
    assert.equal(hook.status, 200, JSON.stringify(hookBody));
    assert.equal(hookBody.outcome, "authorized");
    const bad = await webhookPOST(
      new Request("http://web.local/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": stripeSignature(payload, "whsec_wrong") }, body: payload }),
      {},
    );
    assert.equal(bad.status, 400, "a wrong signature is refused");
    ok(`webhook → 200 authorized (a forged signature → 400) · payment ${(await live.db.getPayment(paymentId))!.status}`);

    // 5. settle on XRPL
    step("5. settlePayment → XRPL testnet");
    await settlePayment(live.deps, paymentId);
    let payment = (await live.db.getPayment(paymentId))!;
    if (payment.status === "settling" || payment.status === "authorized") {
      // Another worker on this DB (a deploy's settle poller) may have taken it: wait for its result.
      console.log(`         payment is ${payment.status}: another worker is settling it; waiting`);
      const until = Date.now() + 120_000;
      while ((payment.status === "settling" || payment.status === "authorized") && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        payment = (await live.db.getPayment(paymentId))!;
      }
    }

    // 6. assertions
    step("6. assertions");
    if (payment.status !== "settled") {
      const [row] = await live.sql.query<{ failure_reason: string | null }>(`select failure_reason from payments where id = $1`, [paymentId]);
      assert.fail(`payment ${payment.status}${row?.failure_reason ? `: ${row.failure_reason}` : ""}`);
    }
    assert.ok(payment.settleTxHash, "settle tx hash recorded");
    ok("payment settled");
    const inv = (await live.db.getInvoice(invoice.id))!;
    assert.equal(inv.status, "paid");
    assert.equal(inv.paymentId, paymentId);
    ok(`invoice ${inv.code} paid by ${paymentId}`);
    const credit = await ledgerRows(live, paymentId);
    assert.deepEqual(credit, [{ kind: "payment_credit", amount: "12.50", currency: cur }]);
    ok("ledger: exactly one payment_credit S$12.50");
    const d = await delivered(live, payment.settleTxHash, cur);
    assert.equal(d.amount.amount, "12.50", "delivered_amount");
    assert.equal(d.destination, address, "paid to the merchant's account");
    assert.equal(d.account, live.engine.context.treasuryAddress(), "paid by the treasury");
    const settleLink = live.engine.explorerUrl(payment.settleTxHash);
    ok(`XRPL delivered_amount exactly 12.50 XSGD to ${short(address)} (InvoiceID ${invoiceIdHex(paymentId).slice(0, 16)}…)`);
    console.log(`           ${settleLink}`);
    const afterSale = await reconcileMerchant(live.deps, merchantId);
    assert.ok(afterSale.ok, describeRec(afterSale));
    assert.equal(toMinor(afterSale.ledger) - toMinor(before.ledger), 1250n, "ledger total +12.50");
    ok(`reconcileMerchant: ${describeRec(afterSale)}`);
    const settledEvent = live.events.find((e) => e.type === "payment.settled");
    assert.ok(settledEvent, "payment.settled emitted (recorded, not sent)");
    const health = await (await (await import("../src/server")).createServer(live.deps).request("/healthz")).json();
    assert.deepEqual([health.ok, health.engine, health.db], [true, "real", "ok"]);
    ok(`worker /healthz on these deps: ${JSON.stringify(health)}`);
    evidence.push(
      `sale: invoice ${inv.code} S$12.50 → ${paymentId} → Stripe ${piId} (${confirmed.amount} ${confirmed.currency}, pm_card_visa) → webhook authorized → settled`,
      `      XRPL ${settleLink} delivered 12.50 XSGD · ledger payment_credit 12.50 · reconcile ✓ ${format(afterSale.ledger)} = ${format(afterSale.onchain!)}`,
    );

    // 7. withdrawal
    if (!withWithdrawal) return;
    step("7. bank account via POST /api/me/bank-accounts (mock partner), then a S$5.00 bank withdrawal");
    let bank = await live.db.getDefaultBankAccount(merchantId);
    if (!bank) {
      const token = signToken<MerchantSessionPayload>(
        { merchantId, scope: "bank", exp: Math.floor(Date.now() / 1000) + 600 },
        need("TOKEN_SECRET"),
      );
      const r = await bankPOST(
        new Request("http://web.local/api/me/bank-accounts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-rove-session": token },
          // A made-up test number for the simulated partner; only last4 + the partner's id reach our DB.
          body: JSON.stringify({ type: "bank_account", bankName: "DBS", accountNumber: "0000001234", holderName: "Ah Seng Food Pte Ltd" }),
        }),
        {},
      );
      const view = (await r.json()) as Record<string, any>;
      assert.equal(r.status, 201, JSON.stringify(view));
      bank = (await live.db.getDefaultBankAccount(merchantId))!;
      ok(`added ${view.bankName} ••••${view.last4} (${view.holderName}), default: ${view.isDefault}`);
    } else {
      ok(`using the default bank account ••••${bank.last4} (${bank.holderName})`);
    }

    const balBefore = await live.db.getBalance(merchantId);
    const wd = await createWithdrawal(live.deps, { merchantId, amount: "5.00", destination: null });
    ok(`requested ${wd.id} · ${format(wd.amount)} → ${wd.destination.label} · fee ${format(wd.fee)} · step-up ${wd.needsStepUp}`);
    const stop = startPartnerCallbacks(live.deps);
    let final: WithdrawalStatus | undefined;
    try {
      await executeWithdrawal(live.deps, wd.id, { actionId: `act_e2e_${wd.id}` });
      const until = Date.now() + 180_000;
      for (;;) {
        const w = await live.db.getWithdrawal(wd.id);
        if (w && FINAL.includes(w.status)) {
          final = w.status;
          break;
        }
        if (Date.now() > until) throw new Error(`withdrawal timed out at ${w?.status}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      await idle(wd.id);
    } finally {
      stop();
    }
    const w = (await live.db.getWithdrawal(wd.id))!;
    const trail = live.events.filter((e) => e.type === "withdrawal.updated" && e.withdrawalId === wd.id).map((e) => (e as { status: string }).status);
    assert.equal(final, "completed", `withdrawal ${final}: ${w.failureReason ?? ""} (${trail.join(" → ")})`);
    ok(`requested → ${trail.join(" → ")} · bank ref ${w.bankRef} (simulated)`);
    const wdRows = await ledgerRows(live, wd.id);
    assert.deepEqual(
      wdRows.map((r) => `${r.kind} ${r.amount}`).sort(),
      ["withdrawal_debit 5.00", "withdrawal_hold 5.00"],
    );
    const balAfter = await live.db.getBalance(merchantId);
    assert.equal(balAfter.available.amount, sub(balBefore.available, money("5.00", cur)).amount, "available −5.00");
    assert.equal(balAfter.held.amount, balBefore.held.amount, "nothing left held");
    ok(`ledger: withdrawal_hold 5.00 + withdrawal_debit 5.00 · available ${format(balBefore.available)} → ${format(balAfter.available)} · held ${format(balAfter.held)}`);
    assert.ok(w.sweepTxHash, "sweep tx recorded");
    const sweep = await delivered(live, w.sweepTxHash, cur);
    assert.equal(sweep.amount.amount, "5.00");
    assert.equal(sweep.account, address);
    assert.equal(sweep.destination, live.engine.context.redemptionAddress());
    const sweepLink = live.engine.explorerUrl(w.sweepTxHash);
    ok(`XRPL sweep delivered exactly 5.00 XSGD ${short(address)} → redemption ${short(sweep.destination)}`);
    console.log(`           ${sweepLink}`);
    const afterWd = await reconcileMerchant(live.deps, merchantId);
    assert.ok(afterWd.ok, describeRec(afterWd));
    ok(`reconcileMerchant: ${describeRec(afterWd)}`);
    evidence.push(
      `withdrawal: ${wd.id} S$5.00 → ${wd.destination.label}: requested → ${trail.join(" → ")} (${w.bankRef}, simulated payout)`,
      `      XRPL ${sweepLink} swept 5.00 XSGD to redemption · ledger hold 5.00 + debit 5.00 · reconcile ✓ ${format(afterWd.ledger)} = ${format(afterWd.onchain!)}`,
    );
  } finally {
    setWebDepsForTests(null);
    await live.close();
  }
}

main().then(
  () => {
    console.log(`\n✓ e2e-smoke passed in ${((Date.now() - t0) / 1000).toFixed(1)}s (${new Date().toISOString()})`);
    for (const l of evidence) console.log(`  ${l}`);
    process.exit(0);
  },
  (err) => {
    console.error(`\n✗ e2e-smoke failed: ${err instanceof Error ? err.message : err}`);
    for (const l of evidence) console.error(`  (passed) ${l}`);
    process.exit(1);
  },
);
