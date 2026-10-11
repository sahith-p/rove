// `pnpm seed` (NI-A2): idempotent XRPL testnet setup. Spec: settlement-xrpl.md §2.
// Every step reads the ledger first and only acts on what's missing, so a second run submits nothing.
// State lives in .env.seed (gitignored, mode 0600): seeds are written there BEFORE their accounts are funded.

import { toUnits, fromUnits } from "@rove/shared";
import { Wallet } from "xrpl";
import { errorMessage, getConnection, type XrplConnection } from "./client";
import type { XrplConfig } from "./config";
import { createContext, explorerAccountUrl, explorerTxUrl } from "./context";
import { decryptSeed, encryptSeed, generateEncryptionKey } from "./crypto";
import { currencyHex, plainDecimal, SGD_CODE, USD_CODE, type IssuedAmount } from "./currency";
import { readEnvFile, upsertEnvFile } from "./envfile";
import { findLine, getAccountRoot, getAmm, getTrustLines } from "./ledger";
import { createMerchantAccount } from "./merchant";
import { submitQueue } from "./queue";
import { envFileSeedStore } from "./seed-store";
import { submitTx, type SubmitDeps, type TxOutcome } from "./submit";
import { buildAmmCreate, buildDefaultRipple, buildIouPayment, buildTrustSet, LSF_DEFAULT_RIPPLE } from "./tx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SEED_AMOUNTS = {
  lpUsd: "10000",
  lpSgd: "12900",
  treasuryUsd: "5000",
  treasurySgd: "5000",
  /** Top the treasury float back up only when it falls below this fraction of the target (keeps reruns quiet). */
  treasuryLowWater: "2500",
  ammTradingFee: 30,
  /** Faucet top-up for the treasury when its XRP runs low (it funds 3 XRP per merchant). */
  treasuryMinXrpDrops: 30_000_000n,
} as const;

type Role = "USD_ISSUER" | "SGD_ISSUER" | "TREASURY" | "LP" | "REDEMPTION" | "CRED_ISSUER";

/** .env.seed keys per platform account: [seed, address]. */
export const ROLE_KEYS: Record<Role, { seed: string; address: string }> = {
  USD_ISSUER: { seed: "XRPL_USD_ISSUER_SEED", address: "XRPL_USD_ISSUER" },
  SGD_ISSUER: { seed: "XRPL_SGD_ISSUER_SEED", address: "XRPL_SGD_ISSUER" },
  TREASURY: { seed: "XRPL_TREASURY_SEED", address: "XRPL_TREASURY_ADDRESS" },
  LP: { seed: "XRPL_LP_SEED", address: "XRPL_LP_ADDRESS" },
  REDEMPTION: { seed: "XRPL_REDEMPTION_SEED", address: "XRPL_REDEMPTION_ADDRESS" },
  CRED_ISSUER: { seed: "XRPL_CREDENTIAL_ISSUER_SEED", address: "XRPL_CREDENTIAL_ISSUER_ADDRESS" },
};

const HEADER = [
  "# Written by `pnpm seed` (packages/xrpl/scripts/seed.ts). XRPL TESTNET ONLY. Never commit this file.",
  "# Seeds are secrets: copy only the worker's vars into the worker env; the web app needs only the *_ADDRESS/ISSUER vars.",
].join("\n");

export interface SeedOptions {
  envPath: string;
  wss: string;
  /** Overrides for WALLET_ENCRYPTION_KEY (otherwise .env.seed's, otherwise generated). */
  walletEncryptionKey?: string;
  demoMerchantId?: string;
  log?: (line: string) => void;
}

export interface SeedSummary {
  addresses: Record<Role, string>;
  ammAccount: string;
  demoMerchant: { merchantId: string; address: string; credentialStatus: string };
  txs: { label: string; hash: string; url: string }[];
  fauceted: string[];
}

export async function runSeed(opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const conn = getConnection(opts.wss);
  const file = readEnvFile(opts.envPath);
  const txs: SeedSummary["txs"] = [];
  const fauceted: string[] = [];
  const onTx = (label: string, o: TxOutcome) => txs.push({ label, hash: o.hash, url: explorerTxUrl(o.hash) });
  const deps: SubmitDeps = { conn, queue: submitQueue, log: (l) => log(`  ${l}`), explorerUrl: (h) => explorerTxUrl(h), onTx };

  upsertEnvFile(opts.envPath, { XRPL_WSS: opts.wss }, HEADER);

  // 1. Platform accounts (faucet), seeds persisted first.
  const wallets = {} as Record<Role, Wallet>;
  for (const role of Object.keys(ROLE_KEYS) as Role[]) {
    const keys = ROLE_KEYS[role];
    const existingSeed = file[keys.seed] || process.env[keys.seed];
    const wallet = existingSeed ? Wallet.fromSeed(existingSeed) : Wallet.generate();
    if (file[keys.seed] !== wallet.seed || file[keys.address] !== wallet.address) {
      upsertEnvFile(opts.envPath, { [keys.seed]: wallet.seed as string, [keys.address]: wallet.address }); // before funding
    }
    const info = await getAccountRoot(conn, wallet.address);
    if (!info) {
      log(`${role}: funding ${wallet.address} from the testnet faucet…`);
      await faucet(conn, wallet, log);
      fauceted.push(role);
    } else if (role === "TREASURY" && info.balanceDrops < SEED_AMOUNTS.treasuryMinXrpDrops) {
      log(`TREASURY: XRP low (${info.balanceDrops} drops), topping up from the faucet…`);
      await faucet(conn, wallet, log);
      fauceted.push("TREASURY (top-up)");
    }
    wallets[role] = wallet;
  }
  const addr = (r: Role) => wallets[r].address;
  const usd = { currency: currencyHex(USD_CODE), issuer: addr("USD_ISSUER") };
  const sgd = { currency: currencyHex(SGD_CODE), issuer: addr("SGD_ISSUER") };
  const amt = (a: { currency: string; issuer: string }, value: string): IssuedAmount => ({ ...a, value });

  // 2. DefaultRipple on both issuers, before any trust line.
  for (const role of ["USD_ISSUER", "SGD_ISSUER"] as const) {
    const info = await getAccountRoot(conn, addr(role));
    if (info && (info.flags & LSF_DEFAULT_RIPPLE) === 0) {
      await submitTx(deps, wallets[role], buildDefaultRipple(addr(role)), { label: `${role} AccountSet asfDefaultRipple` });
    }
  }

  // 3. Trust lines: TREASURY, LP, REDEMPTION → both issuers.
  for (const role of ["TREASURY", "LP", "REDEMPTION"] as const) {
    const lines = await getTrustLines(conn, addr(role));
    for (const [name, asset] of [["RLUSD", usd], ["XSGD", sgd]] as const) {
      if (findLine(lines, asset.currency, asset.issuer)) continue;
      await submitTx(deps, wallets[role], buildTrustSet({ account: addr(role), ...asset }), { label: `${role} TrustSet ${name}` });
    }
  }

  // 4 + 5. LP liquidity and the AMM (skip both if the pool exists: the LP's tokens are in it).
  let amm = await getAmm(conn, usd, sgd);
  if (!amm) {
    await mintUpTo(deps, conn, wallets.USD_ISSUER, addr("LP"), usd, SEED_AMOUNTS.lpUsd, SEED_AMOUNTS.lpUsd, "LP RLUSD");
    await mintUpTo(deps, conn, wallets.SGD_ISSUER, addr("LP"), sgd, SEED_AMOUNTS.lpSgd, SEED_AMOUNTS.lpSgd, "LP XSGD");
    await submitTx(
      deps,
      wallets.LP,
      buildAmmCreate({ account: addr("LP"), amount: amt(usd, SEED_AMOUNTS.lpUsd), amount2: amt(sgd, SEED_AMOUNTS.lpSgd), tradingFee: SEED_AMOUNTS.ammTradingFee }),
      { label: "LP AMMCreate RLUSD/XSGD" },
    );
    amm = await getAmm(conn, usd, sgd);
    if (!amm) throw new Error("AMMCreate validated but amm_info finds no pool");
  }
  // Treasury floats: RLUSD for USD payers, XSGD for SGD payers and bounced withdrawals.
  await mintUpTo(deps, conn, wallets.USD_ISSUER, addr("TREASURY"), usd, SEED_AMOUNTS.treasuryUsd, SEED_AMOUNTS.treasuryLowWater, "TREASURY RLUSD");
  await mintUpTo(deps, conn, wallets.SGD_ISSUER, addr("TREASURY"), sgd, SEED_AMOUNTS.treasurySgd, SEED_AMOUNTS.treasuryLowWater, "TREASURY XSGD");

  // 6. Encryption key + demo merchant.
  const fileKey = file.WALLET_ENCRYPTION_KEY || undefined;
  const key = opts.walletEncryptionKey || fileKey || generateEncryptionKey();
  const demoId = opts.demoMerchantId ?? "ahseng";
  if (fileKey && fileKey !== key && file.DEMO_MERCHANT_SEED_ENC) {
    // The env key changed: re-encrypt the stored demo seed so the worker (which uses the env key) can sign.
    const seed = decryptSeed(file.DEMO_MERCHANT_SEED_ENC, fileKey);
    upsertEnvFile(opts.envPath, { DEMO_MERCHANT_SEED_ENC: encryptSeed(seed, key) });
    log("re-encrypted DEMO_MERCHANT_SEED_ENC with the WALLET_ENCRYPTION_KEY from the environment");
  }
  if (fileKey !== key) upsertEnvFile(opts.envPath, { WALLET_ENCRYPTION_KEY: key });

  const config: XrplConfig = {
    wss: opts.wss,
    usdIssuer: addr("USD_ISSUER"),
    sgdIssuer: addr("SGD_ISSUER"),
    treasuryAddress: addr("TREASURY"),
    treasurySeed: wallets.TREASURY.seed,
    redemptionAddress: addr("REDEMPTION"),
    credentialIssuerAddress: addr("CRED_ISSUER"),
    credentialIssuerSeed: wallets.CRED_ISSUER.seed,
    walletEncryptionKey: key,
  };
  const ctx = createContext(config, {
    seedStore: envFileSeedStore(opts.envPath, { demoMerchantId: demoId }),
    connection: conn,
    log: (l) => log(`  ${l}`),
    onTx,
  });
  const demo = await createMerchantAccount(ctx, demoId);

  // 7. Public vars (seeds were written as they were created).
  upsertEnvFile(opts.envPath, {
    XRPL_WSS: opts.wss,
    XRPL_AMM_ACCOUNT: amm.account,
    DEMO_MERCHANT_ID: demoId,
  });
  const addresses = Object.fromEntries((Object.keys(ROLE_KEYS) as Role[]).map((r) => [r, addr(r)])) as Record<Role, string>;
  return { addresses, ammAccount: amm.account, demoMerchant: { merchantId: demoId, address: demo.xrplAddress, credentialStatus: demo.credentialStatus }, txs, fauceted };
}

/** Issuer → holder payment of whatever brings `holder` up to `target`, only if it's below `lowWater`. */
async function mintUpTo(
  deps: SubmitDeps,
  conn: XrplConnection,
  issuer: Wallet,
  holder: string,
  asset: { currency: string; issuer: string },
  target: string,
  lowWater: string,
  label: string,
): Promise<void> {
  const line = findLine(await getTrustLines(conn, holder, asset.issuer), asset.currency, asset.issuer);
  if (!line) throw new Error(`${label}: ${holder} has no trust line to ${asset.issuer}`);
  const balance = plainDecimal(line.balance);
  const have = balance.startsWith("-") ? 0n : toUnits(balance, 6, "floor");
  if (have >= toUnits(lowWater, 6)) return;
  const shortfall = toUnits(target, 6) - have;
  if (shortfall <= 0n) return;
  const value = fromUnits(shortfall, 6).replace(/\.?0+$/, "");
  await submitTx(deps, issuer, buildIouPayment({ account: issuer.address, destination: holder, amount: { ...asset, value } }), {
    label: `mint ${value} → ${label}`,
  });
}

/** Testnet faucet with patience: rate limits and hiccups are retried with backoff. */
async function faucet(conn: XrplConnection, wallet: Wallet, log: (l: string) => void): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await conn.run((c) => c.fundWallet(wallet), { retries: 1 });
      return;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(60_000, 5_000 * 2 ** attempt);
      log(`  faucet: ${errorMessage(err).slice(0, 160)}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      if (await getAccountRoot(conn, wallet.address)) return; // funded despite the error
    }
  }
  throw new Error(`faucet failed for ${wallet.address}: ${errorMessage(lastErr)}`);
}

export function printSeedSummary(s: SeedSummary, log: (l: string) => void = console.log): void {
  log("");
  log("Accounts (testnet):");
  for (const [role, address] of Object.entries(s.addresses)) log(`  ${role.padEnd(12)} ${explorerAccountUrl(address)}`);
  log(`  ${"AMM".padEnd(12)} ${explorerAccountUrl(s.ammAccount)}`);
  log(`  ${("merchant " + s.demoMerchant.merchantId).padEnd(12)} ${explorerAccountUrl(s.demoMerchant.address)} (credential: ${s.demoMerchant.credentialStatus})`);
  log("");
  if (s.fauceted.length) log(`Faucet: ${s.fauceted.join(", ")}`);
  if (s.txs.length === 0) {
    log("Transactions this run: none (everything was already in place)");
  } else {
    log(`Transactions this run (${s.txs.length}):`);
    for (const t of s.txs) log(`  ${t.label}: ${t.url}`);
  }
}
