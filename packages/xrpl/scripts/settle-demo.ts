// pnpm --filter @rove/xrpl settle:demo — gate G1 check. Owner: Nithya (task NI-A3).
// quote(S$12.50) → settle() treasury → demo merchant (ahseng) → print delivered_amount + explorer URL.
// Pass = exactly 12.50 XSGD delivered (normalized with money()). Loads .env.seed (run `pnpm seed` first).

import { money, newId } from "@rove/shared";
import { createXrplSettlement, xrplConfigFromEnv } from "../src/index";
import { getTrustLines, findLine } from "../src/ledger";
import { ENV_SEED_PATH, loadScriptEnv, testnetWss } from "./_env";

async function main() {
  loadScriptEnv();
  testnetWss();
  const merchant = process.env.DEMO_MERCHANT_XRPL_ADDRESS;
  if (!merchant) throw new Error(`DEMO_MERCHANT_XRPL_ADDRESS missing: run \`pnpm seed\` (expects ${ENV_SEED_PATH})`);
  const engine = createXrplSettlement(xrplConfigFromEnv());
  try {
    const local = money(process.argv[2] ?? "12.50", "SGD");
    const sgd = engine.context.sgd();
    const xsgdBefore = findLine(await getTrustLines(engine.context.conn, merchant, sgd.issuer), sgd.currency, sgd.issuer)?.balance ?? "0";

    const q = await engine.quote({ local });
    console.log(`quote:  S$${q.local.amount} ← US$${q.usd.amount} at ${q.rate} SGD/USD · SendMax ${q.sendMaxUsd} RLUSD · expires ${q.expiresAt}`);

    const paymentId = newId("pay");
    const res = await engine.settle({ paymentId, merchantAddress: merchant, local, sendMaxUsd: q.sendMaxUsd, from: "USD" });
    const delivered = money(res.delivered, "SGD");
    const xsgdAfter = findLine(await getTrustLines(engine.context.conn, merchant, sgd.issuer), sgd.currency, sgd.issuer)?.balance ?? "0";

    console.log(`settle: ${paymentId} → ${merchant} (ahseng)`);
    console.log(`        delivered_amount ${delivered.amount} XSGD · ledger ${res.ledgerIndex}`);
    console.log(`        merchant XSGD ${xsgdBefore} → ${xsgdAfter}`);
    console.log(`        ${engine.explorerUrl(res.txHash)}`);
    const pass = delivered.amount === local.amount;
    console.log(pass ? `G1 PASS: exactly ${local.amount} XSGD delivered` : `G1 FAIL: delivered ${delivered.amount}, expected ${local.amount}`);
    if (!pass) process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error("settle:demo failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
