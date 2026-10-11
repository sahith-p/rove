// Demo reset: make a merchant's XRPL account match an empty ledger. Owner: Nithya · Task: NI-C7.
//
//   pnpm --filter worker exec tsx scripts/demo-reset.ts ahseng             # sends the XSGD back, then reconciles
//   pnpm --filter worker exec tsx scripts/demo-reset.ts ahseng --dry-run   # only says what it would do
//   (from a worktree without its own .env: ROVE_DOTENV=/path/to/rove/.env pnpm --filter worker exec tsx …)
//
// Why: the demo merchant's testnet account holds XSGD from gate-G1 runs (settle:demo) that have no payment in the
// database, so the reconciler would report drift all demo long. This sends the merchant's ENTIRE XSGD balance back to
// the treasury (same-currency XSGD Payment signed with the merchant's custodial seed, via the engine), so
// XRPL = ledger = S$0.00, then runs reconcileMerchant.
//
// Guards (it refuses otherwise): XRPL testnet only; the merchant exists, is live and has a custodial account whose
// seed is in the DB; its ledger has NO entries at all (if any sale, refund or withdrawal was ever recorded, the XSGD
// belongs to the ledger's story and must not be swept away by a script).

import { money, toMinor, type MerchantId } from "@rove/shared";
import { buildIouPayment, invoiceIdFor, plainDecimal } from "@rove/xrpl";
import { submitTx } from "../../../packages/xrpl/src/submit";
import { reconcileMerchant } from "../src/reconcile";
import { assertTestnet, liveWorker, loadEnv, rawXsgd, short, type LiveWorker } from "./_lib";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const merchantId = args.find((a) => !a.startsWith("--")) as MerchantId | undefined;

async function main(): Promise<void> {
  if (!merchantId) throw new Error("usage: demo-reset.ts <merchantId> [--dry-run]");
  const envFile = loadEnv();
  const wss = assertTestnet();
  console.log(`demo-reset ${merchantId}${dryRun ? " (dry run)" : ""} · XRPL ${wss} · env ${envFile ? "file + environment" : "environment only"}`);

  const live = liveWorker({ scope: "demo-reset" });
  try {
    await reset(live, merchantId);
  } finally {
    await live.close();
  }
}

async function reset(live: LiveWorker, id: MerchantId): Promise<void> {
  const { db, engine, sql } = live;
  const merchant = await db.getMerchant(id);
  if (!merchant) throw new Error(`merchant ${id} isn't in the database (run \`pnpm --filter @rove/db seed:demo\` first)`);
  if (merchant.status !== "live") throw new Error(`merchant ${id} is ${merchant.status}, not live`);
  const address = merchant.xrplAddress;
  if (!address) throw new Error(`merchant ${id} has no XRPL account in the database (seed:demo with DEMO_MERCHANT_XRPL_ADDRESS)`);

  const [{ n }] = (await sql.query<{ n: number }>(`select count(*)::int as n from ledger_entries where merchant_id = $1`, [id])) as [{ n: number }];
  if (n > 0) {
    throw new Error(`refusing: ${id} has ${n} ledger entr${n === 1 ? "y" : "ies"}. This script only resets a merchant whose ledger is empty.`);
  }
  const treasury = engine.context.treasuryAddress();
  const before = plainDecimal(await rawXsgd(engine, address));
  console.log(`merchant ${id} · account ${address} · ledger entries 0 · XSGD on XRPL ${before}`);

  if (before === "0" || /^0(\.0+)?$/.test(before)) {
    console.log("nothing to send back");
  } else if (before.startsWith("-")) {
    throw new Error(`unexpected negative XSGD balance ${before} on ${address}`);
  } else if (dryRun) {
    console.log(`would send ${before} XSGD ${short(address)} → treasury ${short(treasury)}`);
  } else {
    await sendBack(live, id, address, treasury, before);
  }

  const after = plainDecimal(await rawXsgd(engine, address));
  console.log(`XSGD on XRPL now ${after}`);
  const r = await reconcileMerchant(live.deps, id);
  console.log(`reconcileMerchant(${id}) → ${JSON.stringify({ ok: r.ok, status: r.status, ledger: r.ledger.amount, onchain: r.onchain?.amount ?? null, diff: r.diff })}`);
  if (!r.ok && !dryRun) process.exitCode = 1;
}

/**
 * Whole cents go through the engine's own merchant → treasury XSGD payment (refund(): exact same-currency amount,
 * delivered_amount checked). Sub-cent dust, if any, can't be expressed as Money, so a tiny helper sends the exact
 * remainder with the engine's submit path (same signer queue, validation wait and error typing).
 */
async function sendBack(live: LiveWorker, id: MerchantId, address: string, treasury: string, raw: string): Promise<void> {
  const { engine } = live;
  const [whole = "0", frac = ""] = raw.split(".");
  const cents = money(`${whole}.${frac.slice(0, 2).padEnd(2, "0")}`, "SGD");
  const ref = `demo-reset:${id}:${Date.now()}`;
  if (toMinor(cents) > 0n) {
    const { txHash } = await engine.refund({ paymentId: ref, merchantAddress: address, local: cents });
    console.log(`sent ${cents.amount} XSGD ${short(address)} → treasury ${short(treasury)}: ${engine.explorerUrl(txHash)}`);
  }
  const rest = plainDecimal(await rawXsgd(engine, address));
  if (rest !== "0" && !/^0(\.0+)?$/.test(rest)) {
    const sgd = engine.context.sgd();
    const wallet = await engine.context.merchantWallet(address);
    const tx = buildIouPayment({ account: address, destination: treasury, amount: { ...sgd, value: rest }, invoiceId: invoiceIdFor(`${ref}:dust`) });
    const out = await submitTx(engine.context, wallet, tx, { label: `demo-reset dust ${id}` });
    console.log(`sent the remaining ${rest} XSGD (sub-cent dust): ${engine.explorerUrl(out.hash)}`);
  }
}

main().catch((err) => {
  console.error("demo-reset failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
