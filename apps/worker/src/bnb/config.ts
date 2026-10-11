// BNB lane config for the worker (env, see .env.example). Owner: Nithya · Task: NI-C6 · Spec: docs/specs/bnb-lane.md.

import { getAddress, isAddress, type Address } from "viem";

export const BSC_TESTNET_CHAIN_ID = 97;
/** A deposit counts once its block has this many confirmations (the block itself + 2 on top). */
export const BNB_CONFIRMATIONS = 3;
/** A deposit that lands after the quote expired is still accepted for this long (Rove absorbs the drift). */
export const LATE_GRACE_MS = 60 * 60_000;
/**
 * The bnbchain.org data-seed endpoints refuse eth_getLogs ("limit exceeded", even for one block), which the watcher
 * needs; publicnode serves it (ranges up to 50k blocks).
 */
export const DEFAULT_BSC_RPC_URL = "https://bsc-testnet-rpc.publicnode.com";

export interface BnbConfig {
  rpcUrl: string;
  /** Set when BSC_RPC_URL pointed at an endpoint known to refuse eth_getLogs, and the default replaced it. */
  rpcReplaced: string | null;
  token: Address;
  decimals: number;
  confirmations: number;
  /** Poll period (ms). */
  pollMs: number;
  /**
   * On boot the cursor starts this many blocks back, so deposits made while the worker was down are still seen
   * (claim() makes the rescan safe). Default 10_000 ≈ 75 min at BSC testnet's 0.45 s blocks: covers the late-grace hour.
   */
  rescanBlocks: bigint;
  /** Largest block span per eth_getLogs call. */
  maxBlockRange: bigint;
  lateGraceMs: number;
  /** Worker only: for sweeping deposits later. Detection doesn't need it. */
  mnemonic: string | null;
  /** If set here too, checked against the mnemonic on boot (the web derives from it). */
  xpub: string | null;
}

type Env = Record<string, string | undefined>;

const posInt = (v: string | undefined, fallback: number, name: string): number => {
  if (!v?.trim()) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${v}`);
  return n;
};

/** bnbchain.org's public data-seed nodes answer eth_getLogs with "limit exceeded" for any range (checked 2026-10-11). */
const NO_GETLOGS = /^https?:\/\/data-seed-prebsc-\d+-s\d+\.(bnbchain|binance)\.org/i;

/** null when BSC_TOKEN_ADDRESS isn't set (the lane is off). Throws on malformed values. */
export function bnbConfigFromEnv(env: Env = process.env): BnbConfig | null {
  const token = env.BSC_TOKEN_ADDRESS?.trim();
  if (!token) return null;
  if (!isAddress(token, { strict: false })) throw new Error("BSC_TOKEN_ADDRESS is not an EVM address");
  const decimals = posInt(env.BSC_TOKEN_DECIMALS, 18, "BSC_TOKEN_DECIMALS");
  if (decimals < 2 || decimals > 36) throw new Error(`BSC_TOKEN_DECIMALS must be 2..36, got ${decimals}`);
  const configured = env.BSC_RPC_URL?.trim() || DEFAULT_BSC_RPC_URL;
  const replaced = NO_GETLOGS.test(configured) ? configured : null;
  return {
    rpcUrl: replaced ? DEFAULT_BSC_RPC_URL : configured,
    rpcReplaced: replaced,
    token: getAddress(token),
    decimals,
    confirmations: BNB_CONFIRMATIONS,
    pollMs: posInt(env.BSC_POLL_MS, 3000, "BSC_POLL_MS"),
    rescanBlocks: BigInt(posInt(env.BSC_RESCAN_BLOCKS, 10_000, "BSC_RESCAN_BLOCKS")),
    maxBlockRange: BigInt(posInt(env.BSC_LOG_RANGE, 5_000, "BSC_LOG_RANGE")),
    lateGraceMs: LATE_GRACE_MS,
    mnemonic: env.BSC_DEPOSIT_MNEMONIC?.trim() || null,
    xpub: env.BSC_DEPOSIT_XPUB?.trim() || null,
  };
}
