// pnpm seed: idempotent XRPL testnet setup. Owner: Nithya (task NI-A2, corridors). Spec: docs/specs/settlement-xrpl.md §2,
// docs/specs/corridors.md §3. Every enabled currency in the registry (@rove/shared currencies.ts: USD, SGD, EUR):
//  1. Fund platform accounts from the testnet faucet (skipped when .env.seed / the env has them and they exist):
//     one issuer per currency (RLUSD, XSGD, EUR stand-ins), treasury, liquidity provider (LP), redemption (stands in
//     for StraitsX / the stablecoin issuers), credential issuer.
//  2. AccountSet asfDefaultRipple on every issuer (BEFORE any trust line; needed for the AMMs).
//  3. TrustSet from treasury, LP and redemption to every issuer.
//  4. One deep AMM pool per non-USD currency against RLUSD (the hub): AMMCreate if missing (RLUSD/XSGD 1,000,000 /
//     1,290,000; RLUSD/EUR 1,080,000 / 1,000,000; TradingFee 30), or a two-asset AMMDeposit (price unchanged) if an
//     existing pool holds < 500,000 RLUSD.
//  5. Treasury float of 5,000 in each currency (topped up below 2,500).
//  6. Demo merchants via createMerchantAccount(): `ahseng` (SGD) and `cafe-berlin` (EUR) (funding, trust lines, Credential).
//  7. Write .env.seed (repo root, gitignored; ROVE_ENV_SEED overrides) and print explorer links.
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
