// pnpm seed: idempotent XRPL testnet setup. Owner: Nithya (task NI-A2). Spec: docs/specs/settlement-xrpl.md §2
//  1. Fund platform accounts from the testnet faucet (skipped when .env.seed has them and they exist):
//     USD issuer, SGD issuer, treasury, liquidity provider (LP), redemption (stands in for StraitsX), credential issuer.
//  2. AccountSet asfDefaultRipple on both issuers (BEFORE any trust line; needed for the AMM).
//  3. TrustSet from treasury, LP and redemption to both issuers (RLUSD stand-in, XSGD stand-in).
//  4. Mint: issuer → LP (10,000 RLUSD; 12,900 XSGD) and issuer → treasury (5,000 RLUSD; 5,000 XSGD float).
//  5. AMMCreate RLUSD/XSGD from the LP, 10,000 / 12,900 (~1.29 SGD per USD), TradingFee 30.
//  6. Demo merchant `ahseng` via createMerchantAccount() (funding, trust lines, Credential).
//  7. Write .env.seed (repo root, gitignored) and print explorer links.
// Re-running submits nothing unless something is missing (or the treasury float/XRP has run low).

import { closeConnections } from "../src/client";
import { printSeedSummary, runSeed } from "../src/setup";
import { ENV_SEED_PATH, loadScriptEnv, testnetWss } from "./_env";

async function main() {
  loadScriptEnv({ includeSeedFile: false }); // .env supplies WALLET_ENCRYPTION_KEY / XRPL_WSS; .env.seed is read as state
  const wss = testnetWss();
  console.log(`Seeding XRPL testnet (${wss}); state file ${ENV_SEED_PATH}`);
  const summary = await runSeed({
    envPath: ENV_SEED_PATH,
    wss,
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || undefined,
    demoMerchantId: process.env.DEMO_MERCHANT_ID || "ahseng",
  });
  printSeedSummary(summary);
  console.log(`\nWrote ${ENV_SEED_PATH} (gitignored). Copy its XRPL_* vars into .env for the worker; the web app needs only the public ones.`);
}

main()
  .catch((err) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
