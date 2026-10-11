// `pnpm seed` (NI-A2, corridors): idempotent XRPL testnet setup. Spec: settlement-xrpl.md §2, corridors.md §3.
// Every step reads the ledger first and only acts on what's missing, so a second run submits nothing.
// State lives in .env.seed (gitignored, mode 0600): seeds are written there BEFORE their accounts are funded.
// Every enabled currency in the registry gets: an issuer (DefaultRipple before any trust line), trust lines from
// TREASURY / LP / REDEMPTION, a treasury float, and (non-USD) a deep AMM pool against RLUSD, the hub.

import { CURRENCY_CODES, fromUnits, toUnits, type Currency } from "@rove/shared";
import { Wallet } from "xrpl";
import { errorMessage, getConnection, type XrplConnection } from "./client";
import { issuerEnvName, registryCode, type XrplConfig } from "./config";
import { createContext, explorerAccountUrl, explorerTxUrl } from "./context";
import { decryptSeed, encryptSeed, generateEncryptionKey } from "./crypto";
import { currencyHex, plainDecimal, type IssuedAmount } from "./currency";
import { readEnvFile, upsertEnvFile } from "./envfile";
import { findLine, getAccountRoot, getAmm, getTrustLines, type AmmPool } from "./ledger";
import { createMerchantAccount } from "./merchant";
import { submitQueue } from "./queue";
import { envFileSeedStore, merchantEnvKeys } from "./seed-store";
import { submitTx, type SubmitDeps, type TxOutcome } from "./submit";
import { buildAmmCreate, buildAmmDepositTwoAsset, buildDefaultRipple, buildIouPayment, buildTrustSet, LSF_DEFAULT_RIPPLE } from "./tx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SEED_AMOUNTS = {
  /** Fresh RLUSD/XSGD pool (deep from the start; existing shallow pools are deepened, see HUB_POOLS). */
  lpUsd: "1000000",
  lpSgd: "1290000",
  treasuryUsd: "5000",
  treasurySgd: "5000",
  /** Float per enabled currency (RLUSD, XSGD, EUR, …). */
  treasuryFloat: "5000",
  /** Top the treasury float back up only when it falls below this fraction of the target (keeps reruns quiet). */
  treasuryLowWater: "2500",
  ammTradingFee: 30,
  /** Faucet top-up for the treasury when its XRP runs low (it funds 3 XRP per merchant). */
  treasuryMinXrpDrops: 30_000_000n,
} as const;

/**
 * One AMM pool per non-USD currency against RLUSD, so any pair routes in ONE Payment through the hub.
 * `usd` / `local` = the pool created on a fresh network (sets the starting price). Deep on purpose: a S$45 settlement
 * moves a 1.29M-XSGD pool by ~0.007% (vs ~0.7% on the old 12,900-XSGD pool).
 * `minHubDepth`: an existing pool with less RLUSD than this is deepened with a two-asset AMMDeposit up to `usd`,
 * at its CURRENT price (tfTwoAsset never moves the price).
 */
export const HUB_POOLS: Partial<Record<Currency, { usd: string; local: string; minHubDepth: string; note: string }>> = {
  SGD: { usd: SEED_AMOUNTS.lpUsd, local: SEED_AMOUNTS.lpSgd, minHubDepth: "500000", note: "1.29 SGD per USD" },
  EUR: { usd: "1080000", local: "1000000", minHubDepth: "500000", note: "1.08 USD per EUR" },
};

/** Demo merchants: ahseng (SGD, the original) and cafe-berlin (EUR). */
export const DEMO_MERCHANTS: { id: string; currency: Currency }[] = [
  { id: "ahseng", currency: "SGD" },
  { id: "cafe-berlin", currency: "EUR" },
];

type PlatformRole = "TREASURY" | "LP" | "REDEMPTION" | "CRED_ISSUER";
type IssuerRole = `${Currency}_ISSUER`;
type Role = IssuerRole | PlatformRole;

const issuerRole = (c: Currency): IssuerRole => `${c}_ISSUER`;

/** .env.seed keys per platform account: [seed, address]. Issuers: `${issuerEnv}` / `${issuerEnv}_SEED` from the
 *  registry (XRPL_USD_ISSUER, XRPL_SGD_ISSUER, XRPL_ISSUER_EUR, …). */
export const ROLE_KEYS: Record<Role, { seed: string; address: string }> = {
  ...(Object.fromEntries(
    [...CURRENCY_CODES].sort((a, b) => (a === "USD" ? -1 : b === "USD" ? 1 : 0)).map((c) => [issuerRole(c), { seed: `${issuerEnvName(c)}_SEED`, address: issuerEnvName(c) }]),
  ) as Record<IssuerRole, { seed: string; address: string }>),
  TREASURY: { seed: "XRPL_TREASURY_SEED", address: "XRPL_TREASURY_ADDRESS" },
  LP: { seed: "XRPL_LP_SEED", address: "XRPL_LP_ADDRESS" },
  REDEMPTION: { seed: "XRPL_REDEMPTION_SEED", address: "XRPL_REDEMPTION_ADDRESS" },
  CRED_ISSUER: { seed: "XRPL_CREDENTIAL_ISSUER_SEED", address: "XRPL_CREDENTIAL_ISSUER_ADDRESS" },
};

/** .env.seed key for a pool's AMM account (the original RLUSD/XSGD pool keeps XRPL_AMM_ACCOUNT). */
export const ammAccountKey = (c: Currency): string => (c === "SGD" ? "XRPL_AMM_ACCOUNT" : `XRPL_AMM_ACCOUNT_${c}`);

const HEADER = [
  "# Written by `pnpm seed` (packages/xrpl/scripts/seed.ts). XRPL TESTNET ONLY. Never commit this file.",
  "# Seeds are secrets: copy only the worker's vars into the worker env; the web app needs only the *_ADDRESS/ISSUER vars.",
].join("\n");

export interface SeedOptions {
  envPath: string;
  wss: string;
  /** Overrides for WALLET_ENCRYPTION_KEY (otherwise .env.seed's, otherwise generated). */
  walletEncryptionKey?: string;
  /** The SGD demo merchant (default ahseng; stored as DEMO_MERCHANT_*). */
  demoMerchantId?: string;
  /** Other demo merchants (default cafe-berlin in EUR; stored as XRPL_MERCHANT_<ID>_*). */
  extraMerchants?: { id: string; currency: Currency }[];
  log?: (line: string) => void;
}

export interface SeedSummary {
  addresses: Record<Role, string>;
  /** RLUSD/XSGD pool (the original). */
  ammAccount: string;
  /** Pool account per non-USD currency. */
  ammAccounts: Partial<Record<Currency, string>>;
  demoMerchant: { merchantId: string; address: string; credentialStatus: string };
  demoMerchants: { merchantId: string; currency: Currency; address: string; credentialStatus: string }[];
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

  // 1. Platform accounts (faucet), seeds persisted first. A seed already in the environment (e.g. the main checkout's
  //    .env via ROVE_DOTENV) is adopted, so a fresh state file never creates a second set of accounts.
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
  const codes = Object.fromEntries(CURRENCY_CODES.map((c) => [c, registryCode(c)])) as Record<Currency, string>;
  const assetOf = (c: Currency) => ({ currency: currencyHex(codes[c]), issuer: addr(issuerRole(c)) });
  const amt = (a: { currency: string; issuer: string }, value: string): IssuedAmount => ({ ...a, value });
  const usd = assetOf("USD");

  // 2. DefaultRipple on every issuer, before any trust line.
  for (const c of CURRENCY_CODES) {
    const role = issuerRole(c);
    const info = await getAccountRoot(conn, addr(role));
    if (info && (info.flags & LSF_DEFAULT_RIPPLE) === 0) {
      await submitTx(deps, wallets[role], buildDefaultRipple(addr(role)), { label: `${role} AccountSet asfDefaultRipple` });
    }
  }

  // 3. Trust lines: TREASURY, LP, REDEMPTION → every issuer.
  for (const role of ["TREASURY", "LP", "REDEMPTION"] as const) {
    const lines = await getTrustLines(conn, addr(role));
    for (const c of CURRENCY_CODES) {
      const asset = assetOf(c);
      if (findLine(lines, asset.currency, asset.issuer)) continue;
      await submitTx(deps, wallets[role], buildTrustSet({ account: addr(role), ...asset }), { label: `${role} TrustSet ${codes[c]}` });
    }
  }

  // 4 + 5. One deep AMM pool per non-USD currency against RLUSD: create it if missing, else deepen it if shallow.
  const ammAccounts: Partial<Record<Currency, string>> = {};
  for (const c of CURRENCY_CODES) {
    if (c === "USD") continue;
    const spec = HUB_POOLS[c];
    if (!spec) throw new Error(`no HUB_POOLS entry for ${c}: every enabled non-USD currency needs an RLUSD pool (corridors.md §4)`);
    const local = assetOf(c);
    const pair = `RLUSD/${codes[c]}`;
    let amm = await getAmm(conn, usd, local);
    if (!amm) {
      await mintUpTo(deps, conn, wallets.USD_ISSUER, addr("LP"), usd, spec.usd, spec.usd, `LP RLUSD (${pair})`);
      await mintUpTo(deps, conn, wallets[issuerRole(c)], addr("LP"), local, spec.local, spec.local, `LP ${codes[c]}`);
      await submitTx(
        deps,
        wallets.LP,
        buildAmmCreate({ account: addr("LP"), amount: amt(usd, spec.usd), amount2: amt(local, spec.local), tradingFee: SEED_AMOUNTS.ammTradingFee }),
        { label: `LP AMMCreate ${pair} (${spec.note})` },
      );
      amm = await getAmm(conn, usd, local);
      if (!amm) throw new Error(`AMMCreate ${pair} validated but amm_info finds no pool`);
    } else {
      const deposit = deepenAmounts(amm, spec);
      if (deposit) {
        log(`${pair}: pool holds ${plainDecimal(amm.amount.value)} RLUSD (< ${spec.minHubDepth}); depositing ${deposit.usd} RLUSD + up to ${deposit.local} ${codes[c]} at the current price`);
        await mintUpTo(deps, conn, wallets.USD_ISSUER, addr("LP"), usd, deposit.usd, deposit.usd, `LP RLUSD (deepen ${pair})`);
        await mintUpTo(deps, conn, wallets[issuerRole(c)], addr("LP"), local, deposit.local, deposit.local, `LP ${codes[c]} (deepen ${pair})`);
        await submitTx(deps, wallets.LP, buildAmmDepositTwoAsset({ account: addr("LP"), amount: amt(usd, deposit.usd), amount2: amt(local, deposit.local) }), {
          label: `LP AMMDeposit ${pair} (two-asset, price unchanged)`,
        });
        amm = (await getAmm(conn, usd, local)) ?? amm;
      }
    }
    ammAccounts[c] = amm.account;
  }

  // Treasury floats: one per currency (the payer-currency float pays every settlement; also bounced withdrawals).
  for (const c of CURRENCY_CODES) {
    await mintUpTo(deps, conn, wallets[issuerRole(c)], addr("TREASURY"), assetOf(c), SEED_AMOUNTS.treasuryFloat, SEED_AMOUNTS.treasuryLowWater, `TREASURY ${codes[c]}`);
  }

  // 6. Encryption key + demo merchants.
  const fileKey = file.WALLET_ENCRYPTION_KEY || undefined;
  const key = opts.walletEncryptionKey || fileKey || generateEncryptionKey();
  const demoId = opts.demoMerchantId ?? "ahseng";
  const merchants = [{ id: demoId, currency: "SGD" as Currency }, ...(opts.extraMerchants ?? DEMO_MERCHANTS.filter((m) => m.id !== "ahseng"))];
  // Adopt merchant accounts already in the environment but not in this state file (same reason as the seeds above).
  for (const m of merchants) {
    const k = merchantEnvKeys(m.id, demoId);
    if (!file[k.address] && process.env[k.address] && process.env[k.seed]) {
      upsertEnvFile(opts.envPath, { [k.address]: process.env[k.address] as string, [k.seed]: process.env[k.seed] as string });
      file[k.address] = process.env[k.address] as string;
      file[k.seed] = process.env[k.seed] as string;
      log(`${m.id}: adopted ${process.env[k.address]} from the environment`);
    }
  }
  if (fileKey && fileKey !== key) {
    // The env key changed: re-encrypt the stored merchant seeds so the worker (which uses the env key) can sign.
    for (const m of merchants) {
      const k = merchantEnvKeys(m.id, demoId);
      if (!file[k.seed]) continue;
      upsertEnvFile(opts.envPath, { [k.seed]: encryptSeed(decryptSeed(file[k.seed] as string, fileKey), key) });
      log(`re-encrypted ${k.seed} with the WALLET_ENCRYPTION_KEY from the environment`);
    }
  }
  if (fileKey !== key) upsertEnvFile(opts.envPath, { WALLET_ENCRYPTION_KEY: key });

  const config: XrplConfig = {
    wss: opts.wss,
    usdIssuer: addr("USD_ISSUER"),
    sgdIssuer: addr("SGD_ISSUER"),
    issuers: Object.fromEntries(CURRENCY_CODES.map((c) => [c, addr(issuerRole(c))])),
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
  const demoMerchants: SeedSummary["demoMerchants"] = [];
  for (const m of merchants) {
    const r = await createMerchantAccount(ctx, m.id, m.currency);
    demoMerchants.push({ merchantId: m.id, currency: m.currency, address: r.xrplAddress, credentialStatus: r.credentialStatus });
  }

  // 7. Public vars (seeds were written as they were created).
  upsertEnvFile(opts.envPath, {
    XRPL_WSS: opts.wss,
    ...Object.fromEntries(Object.entries(ammAccounts).map(([c, a]) => [ammAccountKey(c as Currency), a as string])),
    DEMO_MERCHANT_ID: demoId,
  });
  const addresses = Object.fromEntries((Object.keys(ROLE_KEYS) as Role[]).map((r) => [r, addr(r)])) as Record<Role, string>;
  const sgdDemo = demoMerchants[0] as SeedSummary["demoMerchants"][number];
  return {
    addresses,
    ammAccount: ammAccounts.SGD ?? "",
    ammAccounts,
    demoMerchant: { merchantId: sgdDemo.merchantId, address: sgdDemo.address, credentialStatus: sgdDemo.credentialStatus },
    demoMerchants,
    txs,
    fauceted,
  };
}

/**
 * Pure: the two-asset deposit that brings a shallow pool's RLUSD side up to `spec.usd`, or null if it already holds at
 * least `spec.minHubDepth`. The local side is the pool's current ratio + 0.1% headroom (tfTwoAsset takes the exact
 * proportional amount and leaves the rest with the LP), so the price doesn't move.
 */
export function deepenAmounts(amm: Pick<AmmPool, "amount" | "amount2">, spec: { usd: string; minHubDepth: string }): { usd: string; local: string } | null {
  const S = 6;
  const poolUsd = toUnits(plainDecimal(amm.amount.value), S, "floor");
  const poolLocal = toUnits(plainDecimal(amm.amount2.value), S, "floor");
  if (poolUsd >= toUnits(spec.minHubDepth, S)) return null;
  const addUsd = toUnits(spec.usd, S) - poolUsd;
  if (addUsd <= 0n || poolUsd <= 0n) return null;
  const addLocal = (addUsd * poolLocal * 1001n + poolUsd * 1000n - 1n) / (poolUsd * 1000n); // ceil, +0.1%
  const trim = (v: bigint) => fromUnits(v, S).replace(/\.?0+$/, "");
  return { usd: trim(addUsd), local: trim(addLocal) };
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
  for (const [c, a] of Object.entries(s.ammAccounts)) log(`  ${`AMM RLUSD/${c}`.padEnd(12)} ${explorerAccountUrl(a as string)}`);
  for (const m of s.demoMerchants) {
    log(`  ${("merchant " + m.merchantId).padEnd(12)} ${explorerAccountUrl(m.address)} (${m.currency}; credential: ${m.credentialStatus})`);
  }
  log("");
  if (s.fauceted.length) log(`Faucet: ${s.fauceted.join(", ")}`);
  if (s.txs.length === 0) {
    log("Transactions this run: none (everything was already in place)");
  } else {
    log(`Transactions this run (${s.txs.length}):`);
    for (const t of s.txs) log(`  ${t.label}: ${t.url}`);
  }
}
