// pnpm --filter @rove/xrpl engine:demo — the whole engine on XRPL testnet (NI-A4 + NI-A5 evidence).
// Creates a fresh merchant (trust lines + Credential), checks verification READ-ONLY (no seeds), and is
// idempotent on a second create. Loads .env.seed (run `pnpm seed` first). The fresh merchant's seed is kept
// in memory only (testnet; it's thrown away at exit).

import { createXrplSettlement, explorerAccountUrl, memorySeedStore, xrplConfigFromEnv, type XrplConfig } from "../src/index";
import { getTrustLines } from "../src/ledger";
import { currencyFromHex } from "../src/currency";
import { loadScriptEnv, testnetWss } from "./_env";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}

async function main() {
  loadScriptEnv();
  testnetWss();
  const full = xrplConfigFromEnv();
  const publicOnly: XrplConfig = {
    wss: full.wss,
    usdIssuer: full.usdIssuer,
    sgdIssuer: full.sgdIssuer,
    treasuryAddress: full.treasuryAddress,
    redemptionAddress: full.redemptionAddress,
    credentialIssuerAddress: full.credentialIssuerAddress,
  };
  const txs: { label: string; hash: string }[] = [];
  const seeds = memorySeedStore();
  const engine = createXrplSettlement(full, { seedStore: seeds, onTx: (label, o) => txs.push({ label, hash: o.hash }) });
  const web = createXrplSettlement(publicOnly); // what the web app has: no seeds at all

  try {
    // 1. Fresh merchant.
    const merchantId = `demo-${Date.now().toString(36)}`;
    console.log(`\n1. createMerchantAccount(${merchantId})`);
    const m = await engine.createMerchantAccount({ merchantId });
    const lines = await getTrustLines(engine.context.conn, m.xrplAddress);
    console.log(`   ${explorerAccountUrl(m.xrplAddress)}`);
    console.log(`   credentialStatus=${m.credentialStatus} · trust lines: ${lines.map((l) => `${currencyFromHex(l.currency)}@${l.account}`).join(", ")}`);
    assert(m.credentialStatus === "accepted", "credential accepted");
    assert(lines.length === 2, "two trust lines");
    assert((await seeds.get(m.xrplAddress))?.startsWith("v1:"), "seed stored encrypted");

    const before = txs.length;
    const again = await engine.createMerchantAccount({ merchantId });
    assert(again.xrplAddress === m.xrplAddress && txs.length === before, "second create is a no-op");
    console.log(`   second createMerchantAccount: same address, 0 new txs`);

    // 2. Verification, read-only.
    const verified = await web.isVerifiedMerchant(m.xrplAddress);
    const ahseng = process.env.DEMO_MERCHANT_XRPL_ADDRESS;
    const ahsengVerified = ahseng ? await web.isVerifiedMerchant(ahseng) : false;
    const treasuryVerified = await web.isVerifiedMerchant(full.treasuryAddress);
    console.log(`\n2. isVerifiedMerchant (read-only engine): new=${verified} ahseng=${ahsengVerified} treasury=${treasuryVerified} garbage=${await web.isVerifiedMerchant("not-an-address")}`);
    assert(verified && ahsengVerified && !treasuryVerified, "verification");

    console.log(`\nTransactions (${txs.length}):`);
    for (const t of txs) console.log(`   ${t.label}: ${engine.explorerUrl(t.hash)}`);
    console.log("\nengine:demo PASS");
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error("engine:demo failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
