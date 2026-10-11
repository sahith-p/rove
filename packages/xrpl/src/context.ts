// Resolved config + connection + signers shared by the engine methods and the seed.
// Signing wallets are created lazily, so a read-only deployment (no seeds) works until a signing method is called.

import { isValidClassicAddress, Wallet } from "xrpl";
import { getConnection, type XrplConnection } from "./client";
import type { XrplConfig } from "./config";
import { decryptSeed } from "./crypto";
import { currencyHex, SGD_CODE, USD_CODE } from "./currency";
import { XrplSigningUnavailableError } from "./errors";
import { submitQueue, type SubmitQueue } from "./queue";
import type { SeedStore } from "./seed-store";
import type { SubmitDeps, TxOutcome } from "./submit";

export interface EngineOptions {
  /** Where encrypted merchant seeds live (worker: the DB). Needed for createMerchantAccount and merchant-signed txs. */
  seedStore?: SeedStore;
  /** One line per submitted tx. Default: console.log with an [xrpl] prefix. */
  log?: (line: string) => void;
  /** Called after every validated tx the engine submits (scripts collect explorer links with it). */
  onTx?: (label: string, outcome: TxOutcome) => void;
  /** Override the shared queue / connection (tests). */
  queue?: SubmitQueue;
  connection?: XrplConnection;
}

export interface Asset {
  currency: string; // on-ledger (hex) code
  issuer: string;
}

export interface EngineContext extends SubmitDeps {
  config: XrplConfig;
  seedStore?: SeedStore;
  /** RLUSD stand-in. Throws if XRPL_USD_ISSUER is missing. */
  usd(): Asset;
  /** XSGD stand-in. Throws if XRPL_SGD_ISSUER is missing. */
  sgd(): Asset;
  treasuryAddress(): string;
  credentialIssuerAddress(): string;
  redemptionAddress(): string;
  treasuryWallet(): Wallet;
  credentialIssuerWallet(): Wallet;
  /** Decrypts the merchant's seed from the SeedStore. */
  merchantWallet(address: string): Promise<Wallet>;
}

const explorer = (base: string | undefined) => (base ?? "https://testnet.xrpl.org").replace(/\/+$/, "");

export function explorerTxUrl(hash: string, base?: string): string {
  return `${explorer(base)}/transactions/${hash}`;
}

export function explorerAccountUrl(address: string, base?: string): string {
  return `${explorer(base)}/accounts/${address}`;
}

function need(value: string | undefined, envName: string, what: string): string {
  if (!value) throw new Error(`${envName} is not set: ${what}. Run \`pnpm seed\` and copy .env.seed into your env.`);
  if (!isValidClassicAddress(value)) throw new Error(`${envName} is not a valid XRPL address: ${value}`);
  return value;
}

export function createContext(config: XrplConfig, opts: EngineOptions = {}): EngineContext {
  const wallets = new Map<string, Wallet>();
  const walletFrom = (seed: string | undefined, envName: string, purpose: string): Wallet => {
    if (!seed) {
      throw new XrplSigningUnavailableError(
        `${envName} is not set, so this engine can't ${purpose}. Signing runs only on the worker; the web app uses the engine read-only.`,
      );
    }
    let w = wallets.get(seed);
    if (!w) {
      w = Wallet.fromSeed(seed);
      wallets.set(seed, w);
    }
    return w;
  };

  const log = opts.log ?? ((line: string) => console.log(`[xrpl] ${line}`));
  const onTx = opts.onTx;
  const base: SubmitDeps = {
    conn: opts.connection ?? getConnection(config.wss),
    queue: opts.queue ?? submitQueue,
    log: (line) => log(line),
    explorerUrl: (hash) => explorerTxUrl(hash, config.explorerBase),
    onTx,
  };

  const ctx: EngineContext = {
    ...base,
    config,
    seedStore: opts.seedStore,
    usd: () => ({ currency: currencyHex(config.usdCode ?? USD_CODE), issuer: need(config.usdIssuer, "XRPL_USD_ISSUER", "the RLUSD issuer") }),
    sgd: () => ({ currency: currencyHex(config.sgdCode ?? SGD_CODE), issuer: need(config.sgdIssuer, "XRPL_SGD_ISSUER", "the XSGD issuer") }),
    treasuryAddress: () =>
      config.treasuryAddress
        ? need(config.treasuryAddress, "XRPL_TREASURY_ADDRESS", "the treasury")
        : config.treasurySeed
          ? walletFrom(config.treasurySeed, "XRPL_TREASURY_SEED", "sign").address
          : need(undefined, "XRPL_TREASURY_ADDRESS", "quotes and settlements need the treasury address"),
    credentialIssuerAddress: () =>
      config.credentialIssuerAddress
        ? need(config.credentialIssuerAddress, "XRPL_CREDENTIAL_ISSUER_ADDRESS", "the credential issuer")
        : config.credentialIssuerSeed
          ? walletFrom(config.credentialIssuerSeed, "XRPL_CREDENTIAL_ISSUER_SEED", "sign").address
          : need(undefined, "XRPL_CREDENTIAL_ISSUER_ADDRESS", "merchant verification needs the credential issuer address"),
    redemptionAddress: () => need(config.redemptionAddress, "XRPL_REDEMPTION_ADDRESS", "bank withdrawals sweep XSGD to the redemption address"),
    treasuryWallet: () => {
      const w = walletFrom(config.treasurySeed, "XRPL_TREASURY_SEED", "sign treasury payments (settle, merchant funding)");
      if (config.treasuryAddress && w.address !== config.treasuryAddress) {
        throw new Error("XRPL_TREASURY_SEED does not match XRPL_TREASURY_ADDRESS");
      }
      return w;
    },
    credentialIssuerWallet: () => {
      const w = walletFrom(config.credentialIssuerSeed, "XRPL_CREDENTIAL_ISSUER_SEED", "issue merchant Credentials");
      if (config.credentialIssuerAddress && w.address !== config.credentialIssuerAddress) {
        throw new Error("XRPL_CREDENTIAL_ISSUER_SEED does not match XRPL_CREDENTIAL_ISSUER_ADDRESS");
      }
      return w;
    },
    merchantWallet: async (address: string) => {
      if (!opts.seedStore) {
        throw new XrplSigningUnavailableError("no SeedStore configured, so this engine can't sign for merchant accounts");
      }
      const enc = await opts.seedStore.get(address);
      if (!enc) throw new XrplSigningUnavailableError(`no custodial seed stored for ${address}`);
      const w = Wallet.fromSeed(decryptSeed(enc, config.walletEncryptionKey));
      if (w.address !== address) throw new Error(`stored seed for ${address} derives ${w.address}`);
      return w;
    },
  };
  return ctx;
}
