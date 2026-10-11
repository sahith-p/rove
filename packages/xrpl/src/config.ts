// Engine configuration. Public values (addresses, endpoint) are enough for the read-only methods the web app
// uses (quote, isVerifiedMerchant, balance, explorerUrl). Seeds live only on the worker.
// Every enabled currency in the registry (@rove/shared currencies.ts) maps to an XRPL token: its stablecoin code
// (registry, overridable) + an issuer address from env (`stablecoin.issuerEnv`, or the generic XRPL_ISSUER_<CODE>).

import { CURRENCY_CODES, currencyInfo, type Currency } from "@rove/shared";
import { DEFAULT_WSS } from "./client";

export interface XrplConfig {
  /** Websocket endpoint. Default: XRPL testnet. */
  wss: string;
  /** Issuer of the RLUSD stand-in (= issuers.USD). */
  usdIssuer: string;
  /** Issuer of the XSGD stand-in (= issuers.SGD). */
  sgdIssuer: string;
  /** Issuer per enabled currency (EUR, …). USD/SGD fall back to usdIssuer/sgdIssuer. */
  issuers?: Partial<Record<Currency, string>>;
  /** Rove's float account; sends every settlement. Derived from treasurySeed when empty. */
  treasuryAddress: string;
  /** Worker only. Signs settlements and merchant funding. */
  treasurySeed?: string;
  /** Stands in for the stablecoin issuers' redemption addresses (StraitsX for XSGD; bank withdrawals). One account
   *  holding a trust line per currency in the demo. */
  redemptionAddress?: string;
  /** Issuer of ROVE_VERIFIED_MERCHANT Credentials. Derived from credentialIssuerSeed when empty. */
  credentialIssuerAddress?: string;
  /** Worker only. Signs CredentialCreate. */
  credentialIssuerSeed?: string;
  /** Worker only. 32-byte hex; decrypts merchant seeds from the SeedStore. */
  walletEncryptionKey?: string;
  /** Currency codes (default RLUSD / XSGD; = codes.USD / codes.SGD). */
  usdCode?: string;
  sgdCode?: string;
  /** XRPL currency code per currency (default: the registry's stablecoin.xrplCode). */
  codes?: Partial<Record<Currency, string>>;
  /** Explorer base URL. Default https://testnet.xrpl.org */
  explorerBase?: string;
}

type Env = Record<string, string | undefined>;

const opt = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Env var names that may hold `currency`'s issuer address, in priority order. */
export function issuerEnvNames(currency: Currency): string[] {
  const named = currencyInfo(currency).stablecoin?.issuerEnv;
  const generic = `XRPL_ISSUER_${currency}`;
  return named && named !== generic ? [named, generic] : [generic];
}

/** The env var we tell people to set for `currency`'s issuer (the registry's name). */
export function issuerEnvName(currency: Currency): string {
  return issuerEnvNames(currency)[0] as string;
}

/** Issuer address for `currency` from config ("" when unset). */
export function issuerFor(config: XrplConfig, currency: Currency): string {
  const fromMap = config.issuers?.[currency];
  if (fromMap) return fromMap;
  if (currency === "USD") return config.usdIssuer;
  if (currency === "SGD") return config.sgdIssuer;
  return "";
}

/** The registry's XRPL code for `currency`'s stablecoin ("RLUSD", "XSGD", "EUR"). */
export function registryCode(currency: Currency): string {
  const code = currencyInfo(currency).stablecoin?.xrplCode;
  if (!code) throw new Error(`${currency} has no stablecoin on XRPL in the registry`);
  return code;
}

/** XRPL currency code (human form, e.g. "XSGD") for `currency`: config override, else the registry's. */
export function codeFor(config: XrplConfig, currency: Currency): string {
  const override = config.codes?.[currency] ?? (currency === "USD" ? config.usdCode : currency === "SGD" ? config.sgdCode : undefined);
  return override || registryCode(currency);
}

/**
 * Reads the env names from .env.example / .env.seed:
 * XRPL_WSS, XRPL_USD_ISSUER, XRPL_SGD_ISSUER, XRPL_ISSUER_<CODE> (e.g. XRPL_ISSUER_EUR; also accepted for USD/SGD),
 * XRPL_TREASURY_ADDRESS, XRPL_TREASURY_SEED, XRPL_REDEMPTION_ADDRESS, XRPL_CREDENTIAL_ISSUER_ADDRESS,
 * XRPL_CREDENTIAL_ISSUER_SEED, WALLET_ENCRYPTION_KEY.
 * Never throws: missing values surface as clear errors from the method that needs them.
 */
export function xrplConfigFromEnv(env: Env = process.env): XrplConfig {
  const issuers: Partial<Record<Currency, string>> = {};
  for (const c of CURRENCY_CODES) {
    for (const name of issuerEnvNames(c)) {
      const v = opt(env[name]);
      if (v) {
        issuers[c] = v;
        break;
      }
    }
  }
  return {
    wss: opt(env.XRPL_WSS) ?? DEFAULT_WSS,
    usdIssuer: issuers.USD ?? "",
    sgdIssuer: issuers.SGD ?? "",
    issuers,
    treasuryAddress: opt(env.XRPL_TREASURY_ADDRESS) ?? "",
    treasurySeed: opt(env.XRPL_TREASURY_SEED),
    redemptionAddress: opt(env.XRPL_REDEMPTION_ADDRESS),
    credentialIssuerAddress: opt(env.XRPL_CREDENTIAL_ISSUER_ADDRESS),
    credentialIssuerSeed: opt(env.XRPL_CREDENTIAL_ISSUER_SEED),
    walletEncryptionKey: opt(env.WALLET_ENCRYPTION_KEY),
  };
}
