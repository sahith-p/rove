// BNB Chain (BSC testnet) helpers for the web. Owner: Nithya · Task: NI-C6 · Spec: docs/specs/bnb-lane.md.
//
// Per-payment deposit addresses come from an ACCOUNT xpub (m/44'/60'/0'/0), never from a seed: Vercel can derive
// m/44'/60'/0'/0/<n> for any n but can't spend from it. The worker derives the same addresses from
// BSC_DEPOSIT_MNEMONIC (apps/worker/src/bnb/keys.ts) for sweeping; bsc.test.ts proves both give the same address.
//
//   const cfg = bscConfigFromEnv();               // null when the lane isn't configured → checkout answers 503
//   depositAddressAt(cfg.xpub, await db.nextDepositIndex())

import { bytesToHex, getAddress, isAddress, type Address } from "viem";
import { HDKey, publicKeyToAddress } from "viem/accounts";

export const BSC_TESTNET_CHAIN_ID = 97 as const;
/** BIP-44 Ethereum account 0, external chain. BSC_DEPOSIT_XPUB is the extended public key of this node. */
export const DEPOSIT_ACCOUNT_PATH = "m/44'/60'/0'/0";
/** Non-hardened child indexes only (an xpub can't derive hardened ones). */
const MAX_INDEX = 2 ** 31 - 1;

export interface BscWebConfig {
  /** Account xpub (m/44'/60'/0'/0). Public. */
  xpub: string;
  /** Test stablecoin (BEP-20) on BSC testnet, checksummed. */
  token: Address;
  decimals: number;
}

type Env = Record<string, string | undefined>;

/**
 * The BNB lane's web config, or null when BSC_DEPOSIT_XPUB / BSC_TOKEN_ADDRESS aren't set (the lane is off).
 * Throws on a malformed value (a private key where the xpub goes, a bad token address): that's our bug, not the payer's.
 */
export function bscConfigFromEnv(env: Env = process.env): BscWebConfig | null {
  const xpub = env.BSC_DEPOSIT_XPUB?.trim();
  const token = env.BSC_TOKEN_ADDRESS?.trim();
  if (!xpub || !token) return null;
  if (!isAddress(token, { strict: false })) throw new Error("BSC_TOKEN_ADDRESS is not an EVM address");
  const rawDecimals = env.BSC_TOKEN_DECIMALS?.trim() || "18";
  const decimals = Number(rawDecimals);
  if (!Number.isInteger(decimals) || decimals < 2 || decimals > 36) throw new Error(`BSC_TOKEN_DECIMALS must be an integer 2..36, got ${rawDecimals}`);
  parseAccountXpub(xpub); // validates
  return { xpub, token: getAddress(token), decimals };
}

const parsed = new Map<string, HDKey>();

/** Parses and checks an account xpub: public only (never an xprv on the web), depth 4 = m/44'/60'/0'/0. */
export function parseAccountXpub(xpub: string): HDKey {
  const hit = parsed.get(xpub);
  if (hit) return hit;
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub);
  } catch (err) {
    throw new Error(`BSC_DEPOSIT_XPUB is not a valid extended public key (${err instanceof Error ? err.message : String(err)})`);
  }
  if (key.privateKey) throw new Error("BSC_DEPOSIT_XPUB holds a private key (xprv). The web must only get the xpub");
  if (key.depth !== 4) throw new Error(`BSC_DEPOSIT_XPUB must be the account xpub at ${DEPOSIT_ACCOUNT_PATH} (depth 4), got depth ${key.depth}`);
  parsed.set(xpub, key);
  return key;
}

/** The deposit address m/44'/60'/0'/0/<index>, checksummed. Same as the worker's mnemonic-derived address. */
export function depositAddressAt(xpub: string, index: number): Address {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error(`deposit index out of range: ${index}`);
  const child = parseAccountXpub(xpub).deriveChild(index);
  if (!child.publicKey) throw new Error(`no public key at index ${index}`);
  return publicKeyToAddress(uncompressPublicKey(child.publicKey));
}

// ------------------------------------------------------------------ secp256k1 point decompression
// HDKey gives the 33-byte compressed key; an Ethereum address is keccak256 of the 64-byte uncompressed (x, y).
// viem doesn't export the curve, so recover y from y² = x³ + 7 (mod p). p ≡ 3 (mod 4), so y = (x³ + 7)^((p+1)/4).

const P = 2n ** 256n - 2n ** 32n - 977n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** 33-byte compressed (0x02/0x03 ‖ x) → 0x04 ‖ x ‖ y as hex. */
export function uncompressPublicKey(compressed: Uint8Array): `0x04${string}` {
  const prefix = compressed[0];
  if (compressed.length !== 33 || (prefix !== 2 && prefix !== 3)) throw new Error("expected a 33-byte compressed secp256k1 public key");
  const x = BigInt(bytesToHex(compressed.subarray(1)));
  if (x >= P) throw new Error("public key x is not a field element");
  const ySquared = (modPow(x, 3n, P) + 7n) % P;
  let y = modPow(ySquared, (P + 1n) / 4n, P);
  if ((y * y) % P !== ySquared) throw new Error("public key is not on secp256k1");
  if ((y & 1n) !== BigInt(prefix & 1)) y = P - y;
  return `0x04${x.toString(16).padStart(64, "0")}${y.toString(16).padStart(64, "0")}`;
}
