// Live proof of the corridors (docs/specs/corridors.md, Phase B): a payer in one currency, a merchant in another, one
// market-rate stablecoin swap on XRPL, no card FX. Owner: Nithya.
//
//   ROVE_DOTENV=/path/to/rove/.env pnpm --filter worker exec tsx scripts/e2e-corridors.ts [a] [b] [c]   (default: all)
//
// REAL Supabase DB (DATABASE_URL), REAL Stripe sandbox (sk_test_ only), REAL XRPL testnet; USE_MOCK_SETTLEMENT is
// forced to 0 for this run. Payouts use the simulated partners (StraitsX-shaped for SGD, SEPA-shaped for EUR).
//   a) EUR payer → ahseng (SGD): one-time code for S$12.50 from the DB menu → POST /api/checkout { payCurrency: EUR }
//      → a real EUR PaymentIntent, confirmed with pm_card_visa → signed payment_intent.succeeded webhook → settlePayment:
//      ONE XRPL Payment EUR → RLUSD → XSGD (SendMax in EUR, both hub pools) delivering exactly 12.50 XSGD → ledger credit
//      → reconcile ok. Then the sale is refunded in full (worker refunds: XSGD back to the treasury, Stripe refund in EUR),
//      so ahseng's balance is exactly what it was before the run.
//   b) USD payer → cafe-berlin (EUR): fixed-QR basket (2 × Flat white + 1 × Croissant = €10.10) → USD PaymentIntent
//      → webhook → ONE Payment RLUSD → EUR delivering exactly 10.10 EUR → ledger credit → reconcile ok.
//   c) cafe-berlin bank withdrawal: IBAN via POST /api/me/bank-accounts (simulated SEPA partner) → €5.00 withdrawal
//      through the real pipeline (sweep EUR to the redemption account on XRPL → simulated SEPA Instant payout)
//      → ledger hold + debit → reconcile ok.
// Before b) on a fresh DB: `pnpm --filter @rove/db seed:demo` then `scripts/demo-reset.ts cafe-berlin` (the EUR shop's
// XRPL account holds Phase A test settlements that have no DB rows; demo-reset sends them back while its ledger is empty).
// Events are recorded in memory, not sent: the real agent must not text anyone about a test sale.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getDb } from "@rove/db";
import {
  format,
  money,
  signToken,
  sub,
  toMinor,
  type Currency,
  type MerchantId,
  type MerchantSessionPayload,
  type Money,
  type WithdrawalStatus,
} from "@rove/shared";
import { plainDecimal } from "@rove/xrpl";
import { installMoneyLog } from "../src/boot";
import { reconcileMerchant, type ReconcileResult } from "../src/reconcile";
import { handleRefund } from "../src/refunds";
import { invoiceIdHex, settlePayment } from "../src/settle";
import { createWithdrawal } from "../src/withdrawals/create";
import { executeWithdrawal } from "../src/withdrawals/execute";
import { idle } from "../src/withdrawals/lock";
import { startPartnerCallbacks } from "../src/withdrawals/partner";
import { assertTestnet, fetchTx, liveWorker, loadEnv, need, recordingEmitter, short, type LiveWorker } from "./_lib";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const runs = new Set(args.length ? args : ["a", "b", "c"]);
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
process.env.WORKER_URL = "http://127.0.0.1:9"; // the webhook's settle nudge fails fast; this script settles itself
const wss = assertTestnet();
const stripeKey = need("STRIPE_SECRET_KEY");
if (!stripeKey.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)");
const webhookSecret = need("STRIPE_WEBHOOK_SECRET");
need("DATABASE_URL");
need("XRPL_ISSUER_EUR");

const { createWebDeps, setWebDepsForTests } = await import("../../web/app/api/_lib/deps");
const { POST: checkoutPOST } = await import("../../web/app/api/checkout/route");
const { POST: webhookPOST } = await import("../../web/app/api/stripe/webhook/route");
const { POST: bankPOST } = await import("../../web/app/api/me/bank-accounts/route");

type Web = ReturnType<typeof createWebDeps>;

// ------------------------------------------------------------------ helpers

function stripeSignature(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

async function ledgerRows(live: LiveWorker, ref: string): Promise<{ kind: string; amount: string; currency: string }[]> {
  return live.sql.query(`select kind, amount::text as amount, currency from ledger_entries where ref = $1 order by created_at, kind`, [ref]);
}

function describeRec(r: ReconcileResult): string {
  return `ledger ${format(r.ledger)} (available ${format(r.available)}, held ${format(r.held)}) vs XRPL ${r.onchain ? format(r.onchain) : "?"} → ${r.status}`;
}

async function reconciled(live: LiveWorker, merchantId: MerchantId, label: string): Promise<ReconcileResult> {
  const r = await reconcileMerchant(live.deps, merchantId);
  assert.ok(r.ok, `${label}: ${describeRec(r)}${r.error ? ` (${r.error})` : ""}`);
  ok(`reconcile ${merchantId} ${label}: ${describeRec(r)}`);
  return r;
}

/** A validated Payment: what it delivered (checked to be `to`'s stablecoin from our issuer), its SendMax token, and which AMMs it touched. */
async function inspectPayment(live: LiveWorker, hash: string, to: Currency) {
  const tx = await fetchTx(live.engine, hash);
  const meta = tx.meta as Record<string, any>;
  const json = (tx.tx_json ?? tx) as Record<string, any>;
  assert.equal(meta.TransactionResult, "tesSUCCESS", `${hash}: ${meta.TransactionResult}`);
  assert.equal(tx.validated, true, "validated");
  const asset = live.engine.context.asset(to);
  const d = meta.delivered_amount as { currency: string; issuer: string; value: string };
  assert.equal(typeof d, "object", "delivered_amount is a token amount");
  assert.deepEqual([d.currency, d.issuer], [asset.currency, asset.issuer], "delivered the merchant's stablecoin from our issuer");
  const sendMax = json.SendMax as { currency: string; issuer: string; value: string } | undefined;
  const metaText = JSON.stringify(meta);
  const amms = { "RLUSD/XSGD": process.env.XRPL_AMM_ACCOUNT, "RLUSD/EUR": process.env.XRPL_AMM_ACCOUNT_EUR };
  const pools = Object.entries(amms)
    .filter(([, addr]) => addr && metaText.includes(addr))
    .map(([name]) => name);
  return {
    delivered: money(plainDecimal(d.value), to),
    sendMax,
    account: String(json.Account),
    destination: String(json.Destination),
    pools,
    invoiceId: String(json.InvoiceID ?? ""),
  };
}

/** The asset currency code on the ledger for `c` (hex for codes longer than 3 chars). */
const ledgerCode = (live: LiveWorker, c: Currency) => live.engine.context.asset(c).currency;

interface Sale {
  paymentId: string;
  piId: string;
  charge: Money;
  local: Money;
  rate: string;
  settleTx: string;
}

/** checkout → confirm pm_card_visa → signed webhook → settlePayment, with the assertions every corridor shares. */
async function pay(live: LiveWorker, web: Web, label: string, body: Record<string, unknown>, expect: { payer: Currency; local: Money }): Promise<Sale> {
  const stripe = web.stripe!;
  step(`${label} · POST /api/checkout ${JSON.stringify({ target: body.target, method: body.method, payCurrency: body.payCurrency })}`);
  const res = await checkoutPOST(
    new Request("http://web.local/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    {},
  );
  const co = (await res.json()) as Record<string, any>;
  assert.equal(res.status, 200, JSON.stringify(co));
  const paymentId = co.paymentId as string;
  assert.equal(co.charge.currency, expect.payer, "charged in the payer's currency");
  assert.deepEqual(co.local, expect.local);
  assert.deepEqual(co.quote.pay, co.charge, "charge = quote.pay");
  const created = (await live.db.getPayment(paymentId))!;
  const piId = created.stripePaymentIntentId!;
  assert.deepEqual(created.quote?.pay, co.charge, "route stored: quote_pay");
  assert.equal(created.quote?.sendMax, co.quote.sendMax, "route stored: quote_send_max");
  ok(`${paymentId} · charge ${format(co.charge)} for ${format(co.local)} at ${co.quote.rate} (SendMax ${co.quote.sendMax} ${co.charge.currency}) · ${piId}`);

  const confirmed = await stripe.paymentIntents.confirm(piId, { payment_method: "pm_card_visa", return_url: "https://example.com/rove-e2e" });
  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.currency, expect.payer.toLowerCase(), "PaymentIntent in the payer's currency");
  assert.equal(confirmed.amount, Number(toMinor(co.charge)));
  ok(`Stripe ${piId} succeeded · ${confirmed.amount} ${confirmed.currency} (pm_card_visa)`);

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
  ok("signed webhook → 200 authorized");

  await settlePayment(live.deps, paymentId);
  let payment = (await live.db.getPayment(paymentId))!;
  const until = Date.now() + 120_000;
  while ((payment.status === "settling" || payment.status === "authorized") && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000)); // another worker on this DB may have taken it
    payment = (await live.db.getPayment(paymentId))!;
  }
  if (payment.status !== "settled") {
    const [row] = await live.sql.query<{ failure_reason: string | null }>(`select failure_reason from payments where id = $1`, [paymentId]);
    assert.fail(`payment ${payment.status}${row?.failure_reason ? `: ${row.failure_reason}` : ""}`);
  }
  const credit = await ledgerRows(live, paymentId);
  assert.deepEqual(credit, [{ kind: "payment_credit", amount: expect.local.amount, currency: expect.local.currency }]);
  ok(`settled · ledger payment_credit ${format(expect.local)}`);
  return { paymentId, piId, charge: co.charge, local: co.local, rate: co.quote.rate, settleTx: payment.settleTxHash! };
}

// ------------------------------------------------------------------ a) EUR payer → ahseng (SGD)

async function corridorA(live: LiveWorker, web: Web): Promise<void> {
  const merchantId = "ahseng";
  step("a) EUR payer → ahseng (SGD) · EUR → RLUSD → XSGD");
  const merchant = (await live.db.getMerchant(merchantId))!;
  assert.equal(merchant.currency, "SGD");
  const before = await reconciled(live, merchantId, "before");

  const [rice, barley] = await live.db.findMenuItems(merchantId, ["Chicken rice", "Barley drink"]);
  assert.ok(rice?.item && barley?.item, "ahseng's menu has Chicken rice and Barley drink");
  const lines = [
    { menuItemId: rice.item.id, name: rice.item.name, qty: 2, unit: rice.item.price },
    { menuItemId: barley.item.id, name: barley.item.name, qty: 1, unit: barley.item.price },
  ];
  const total = money("12.50", "SGD");
  assert.equal(toMinor(rice.item.price) * 2n + toMinor(barley.item.price), toMinor(total), "2 × Chicken rice + 1 × Barley drink = S$12.50 (DB prices)");
  // A one-time code with no recipient: no contact is added to ahseng's list by this test sale.
  const code = await live.db.createInvoice({ merchantId, kind: "one_time_qr", lines, total, note: "e2e corridors a) (CUR-B)" });
  ok(`one-time code ${code.code} · ${format(code.total)}`);

  const sale = await pay(live, web, "a)", { target: { source: "invoice", code: code.code }, method: "card", payCurrency: "EUR" }, { payer: "EUR", local: total });
  const tx = await inspectPayment(live, sale.settleTx, "SGD");
  assert.equal(tx.delivered.amount, "12.50", "delivered_amount exactly S$12.50");
  assert.equal(tx.destination, merchant.xrplAddress);
  assert.equal(tx.account, live.engine.context.treasuryAddress(), "paid by the treasury");
  assert.equal(tx.sendMax?.currency, ledgerCode(live, "EUR"), "SendMax is in EUR: the EUR float paid");
  assert.equal(tx.invoiceId, invoiceIdHex(sale.paymentId));
  assert.deepEqual(tx.pools.sort(), ["RLUSD/EUR", "RLUSD/XSGD"], "one Payment through both hub pools");
  const link = live.engine.explorerUrl(sale.settleTx);
  ok(`XRPL: ONE Payment, SendMax ${tx.sendMax?.value} EUR → delivered exactly 12.50 XSGD to ${short(tx.destination)} via ${tx.pools.join(" + ")}`);
  console.log(`           ${link}`);
  const afterSale = await reconciled(live, merchantId, "after the sale");
  assert.equal(toMinor(afterSale.ledger) - toMinor(before.ledger), 1250n, "ledger +S$12.50");

  // Refund in full: proves refunds go back in the charge currency (EUR), and leaves ahseng's balance as it was.
  step("a) refund the EUR-charged sale in full (worker refunds)");
  const r = await handleRefund(live.deps, { actionId: `act_e2e_refund_${sale.paymentId}`, paymentId: sale.paymentId, amount: "12.50" });
  assert.equal(r.status, "completed", `refund ${r.status}`);
  const refund = (await live.db.getRefundByAction(`act_e2e_refund_${sale.paymentId}`))!;
  const sr = await web.stripe!.refunds.retrieve(refund.stripeRefundId!);
  assert.equal(sr.currency, "eur", "Stripe refund in EUR");
  assert.equal(sr.amount, Number(toMinor(sale.charge)), "the whole EUR charge back");
  ok(`Stripe refund ${sr.id}: ${sr.amount} ${sr.currency} (${sr.status}) · XRPL ${live.engine.explorerUrl(refund.xrplTxHash!)}`);
  const afterRefund = await reconciled(live, merchantId, "after the refund");
  assert.equal(afterRefund.ledger.amount, before.ledger.amount, "ahseng's balance is back where it was");

  evidence.push(
    `a) EUR payer → ahseng: ${code.code} S$12.50 → ${sale.paymentId} → Stripe ${sale.piId} ${format(sale.charge)} (rate ${sale.rate} S$/€) → webhook → settled`,
    `      XRPL ${link}: SendMax €${tx.sendMax?.value}, delivered 12.50 XSGD via ${tx.pools.join(" + ")} · ledger +12.50 · reconcile ✓ ${format(afterSale.ledger)}`,
    `      refund: Stripe ${sr.id} ${sr.amount} ${sr.currency} · XRPL ${live.engine.explorerUrl(refund.xrplTxHash!)} · reconcile ✓ ${format(afterRefund.ledger)} (= before)`,
  );
}

// ------------------------------------------------------------------ b) USD payer → cafe-berlin (EUR)

async function corridorB(live: LiveWorker, web: Web): Promise<void> {
  const merchantId = "cafe-berlin";
  step("b) USD payer → cafe-berlin (EUR) · RLUSD → EUR");
  const merchant = await live.db.getMerchant(merchantId);
  assert.ok(merchant?.xrplAddress, "cafe-berlin is in the DB with its XRPL account (pnpm --filter @rove/db seed:demo)");
  assert.deepEqual([merchant.currency, merchant.country, merchant.status], ["EUR", "DE", "live"]);
  const before = await reconciled(live, merchantId, "before (run scripts/demo-reset.ts cafe-berlin first on a fresh DB)");

  const [flat, croissant] = await live.db.findMenuItems(merchantId, ["Flat white", "Croissant"]);
  assert.ok(flat?.item && croissant?.item, "cafe-berlin's EUR menu");
  const items = [
    { menuItemId: flat.item.id, qty: 2 },
    { menuItemId: croissant.item.id, qty: 1 },
  ];
  const local = money("10.10", "EUR");
  const sale = await pay(live, web, "b)", { target: { source: "fixed_qr", merchantId, items }, method: "card", payCurrency: "USD" }, { payer: "USD", local });
  const tx = await inspectPayment(live, sale.settleTx, "EUR");
  assert.equal(tx.delivered.amount, "10.10", "delivered_amount exactly €10.10");
  assert.equal(tx.destination, merchant.xrplAddress);
  assert.equal(tx.sendMax?.currency, ledgerCode(live, "USD"), "SendMax is in RLUSD: the USD float paid");
  assert.deepEqual(tx.pools, ["RLUSD/EUR"], "one hop through the RLUSD/EUR pool");
  const link = live.engine.explorerUrl(sale.settleTx);
  ok(`XRPL: ONE Payment, SendMax ${tx.sendMax?.value} RLUSD → delivered exactly 10.10 EUR to ${short(tx.destination)} via RLUSD/EUR`);
  console.log(`           ${link}`);
  const after = await reconciled(live, merchantId, "after the sale");
  assert.equal(toMinor(after.ledger) - toMinor(before.ledger), 1010n, "ledger +€10.10");
  evidence.push(
    `b) USD payer → cafe-berlin: 2 × Flat white + 1 × Croissant €10.10 → ${sale.paymentId} → Stripe ${sale.piId} ${format(sale.charge)} (rate ${sale.rate} €/US$) → settled`,
    `      XRPL ${link}: SendMax ${tx.sendMax?.value} RLUSD, delivered 10.10 EUR via RLUSD/EUR · ledger +10.10 · reconcile ✓ ${format(after.ledger)}`,
  );
}

// ------------------------------------------------------------------ c) cafe-berlin EUR bank withdrawal (simulated SEPA)

async function corridorC(live: LiveWorker): Promise<void> {
  const merchantId = "cafe-berlin";
  step("c) cafe-berlin · IBAN (simulated SEPA partner) + €5.00 bank withdrawal");
  const merchant = (await live.db.getMerchant(merchantId))!;
  await reconciled(live, merchantId, "before");

  let bank = (await live.db.listBankAccounts(merchantId)).find((b) => b.type === "iban" && b.isDefault) ?? null;
  if (!bank) {
    const token = signToken<MerchantSessionPayload>({ merchantId, scope: "bank", exp: Math.floor(Date.now() / 1000) + 600 }, need("TOKEN_SECRET"));
    const r = await bankPOST(
      new Request("http://web.local/api/me/bank-accounts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-rove-session": token },
        // The standard example IBAN from the IBAN registry (not a real account); only last 4 + the partner id reach our DB.
        body: JSON.stringify({ type: "iban", accountNumber: "DE89 3704 0044 0532 0130 00", holderName: "Café Berlin GmbH" }),
      }),
      {},
    );
    const view = (await r.json()) as Record<string, any>;
    assert.equal(r.status, 201, JSON.stringify(view));
    bank = (await live.db.getBankAccount(view.id))!;
    ok(`added IBAN ••••${view.last4} (${view.holderName}) · beneficiary ${bank.beneficiaryId.replace(/\d{4,}$/, "…")} · default ${view.isDefault}`);
  } else {
    ok(`using IBAN ••••${bank.last4} (${bank.holderName})`);
  }
  assert.equal(bank.isDefault, true, "the IBAN is cafe-berlin's default bank account");

  const balBefore = await live.db.getBalance(merchantId);
  const wd = await createWithdrawal(live.deps, { merchantId, amount: "5.00", destination: null });
  assert.deepEqual([wd.amount, wd.fee], [money("5.00", "EUR"), money("0.00", "EUR")]);
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
  assert.match(w.bankRef ?? "", /^SCTINST-\d{6}$/, "SEPA Instant reference from the simulated partner");
  ok(`requested → ${trail.join(" → ")} · ${w.bankRef} (simulated SEPA)`);
  const rows = await ledgerRows(live, wd.id);
  assert.deepEqual(rows.map((r) => `${r.kind} ${r.amount} ${r.currency}`).sort(), ["withdrawal_debit 5.00 EUR", "withdrawal_hold 5.00 EUR"]);
  const balAfter = await live.db.getBalance(merchantId);
  assert.equal(balAfter.available.amount, sub(balBefore.available, money("5.00", "EUR")).amount, "available −€5.00");
  const sweep = await inspectPayment(live, w.sweepTxHash!, "EUR");
  assert.equal(sweep.delivered.amount, "5.00");
  assert.equal(sweep.account, merchant.xrplAddress);
  assert.equal(sweep.destination, live.engine.context.redemptionAddress());
  const link = live.engine.explorerUrl(w.sweepTxHash!);
  ok(`XRPL sweep delivered exactly 5.00 EUR ${short(sweep.account)} → redemption ${short(sweep.destination)}`);
  console.log(`           ${link}`);
  const after = await reconciled(live, merchantId, "after the withdrawal");
  evidence.push(
    `c) cafe-berlin withdrawal ${wd.id} €5.00 → ${wd.destination.label}: requested → ${trail.join(" → ")} (${w.bankRef}, simulated SEPA)`,
    `      XRPL ${link} swept 5.00 EUR to redemption · ledger hold + debit 5.00 · reconcile ✓ ${format(after.ledger)}`,
  );
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log(`e2e-corridors · ${[...runs].join(", ")} · DB: Supabase · Stripe: sandbox · XRPL: ${wss} · payouts: simulated (StraitsX SGD, SEPA EUR)`);
  console.log(`          env: ${envFile ? "env file + environment" : "environment only"} · USE_MOCK_SETTLEMENT=0 forced`);
  const live = liveWorker({ db: getDb(), scope: "e2e" });
  installMoneyLog(live.deps);
  const webRec = recordingEmitter();
  const web = createWebDeps();
  if (web.db !== live.db) await web.db.close();
  const webDeps = { ...web, db: live.db, emit: webRec.emit };
  setWebDepsForTests(webDeps);
  try {
    if (runs.has("a")) await corridorA(live, webDeps);
    if (runs.has("b")) await corridorB(live, webDeps);
    if (runs.has("c")) await corridorC(live);
  } finally {
    setWebDepsForTests(null);
    await live.close();
  }
}

main().then(
  () => {
    console.log(`\n✓ e2e-corridors passed in ${((Date.now() - t0) / 1000).toFixed(1)}s (${new Date().toISOString()})`);
    for (const l of evidence) console.log(`  ${l}`);
    process.exit(0);
  },
  (err) => {
    console.error(`\n✗ e2e-corridors failed: ${err instanceof Error ? err.message : err}`);
    for (const l of evidence) console.error(`  (passed) ${l}`);
    process.exit(1);
  },
);
