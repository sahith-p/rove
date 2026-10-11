// Engine configuration. Public values (addresses, endpoint) are enough for the read-only methods the web app
// uses (quote, isVerifiedMerchant, balance, explorerUrl). Seeds live only on the worker.

import { DEFAULT_WSS } from "./client";

export interface XrplConfig {
  /** Websocket endpoint. Default: XRPL testnet. */
  wss: string;
  /** Issuer of the RLUSD stand-in. */
  usdIssuer: string;
  /** Issuer of the XSGD stand-in. */
  sgdIssuer: string;
  /** Rove's float account; sends every settlement. Derived from treasurySeed when empty. */
  treasuryAddress: string;
  /** Worker only. Signs settlements and merchant funding. */
  treasurySeed?: string;
  /** Stands in for StraitsX's XSGD redemption address (bank withdrawals). */
  redemptionAddress?: string;
  /** Issuer of ROVE_VERIFIED_MERCHANT Credentials. Derived from credentialIssuerSeed when empty. */
  credentialIssuerAddress?: string;
  /** Worker only. Signs CredentialCreate. */
  credentialIssuerSeed?: string;
  /** Worker only. 32-byte hex; decrypts merchant seeds from the SeedStore. */
  walletEncryptionKey?: string;
  /** Currency codes (default RLUSD / XSGD). */
  usdCode?: string;
  sgdCode?: string;
  /** Explorer base URL. Default https://testnet.xrpl.org */
  explorerBase?: string;
}

type Env = Record<string, string | undefined>;

const opt = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Reads the env names from .env.example / .env.seed:
 * XRPL_WSS, XRPL_USD_ISSUER, XRPL_SGD_ISSUER, XRPL_TREASURY_ADDRESS, XRPL_TREASURY_SEED, XRPL_REDEMPTION_ADDRESS,
 * XRPL_CREDENTIAL_ISSUER_ADDRESS, XRPL_CREDENTIAL_ISSUER_SEED, WALLET_ENCRYPTION_KEY.
 * Never throws: missing values surface as clear errors from the method that needs them.
 */
export function xrplConfigFromEnv(env: Env = process.env): XrplConfig {
  return {
    wss: opt(env.XRPL_WSS) ?? DEFAULT_WSS,
    usdIssuer: opt(env.XRPL_USD_ISSUER) ?? "",
    sgdIssuer: opt(env.XRPL_SGD_ISSUER) ?? "",
    treasuryAddress: opt(env.XRPL_TREASURY_ADDRESS) ?? "",
    treasurySeed: opt(env.XRPL_TREASURY_SEED),
    redemptionAddress: opt(env.XRPL_REDEMPTION_ADDRESS),
    credentialIssuerAddress: opt(env.XRPL_CREDENTIAL_ISSUER_ADDRESS),
    credentialIssuerSeed: opt(env.XRPL_CREDENTIAL_ISSUER_SEED),
    walletEncryptionKey: opt(env.WALLET_ENCRYPTION_KEY),
  };
}
