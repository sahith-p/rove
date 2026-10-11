// Base Sepolia access for the AUSD relayer: config from env and the viem client that submits transferWithAuthorization.
// Owner: Nithya · Spec: docs/specs/ausd-lane.md. The relayer key lives only in the worker (never on Vercel) and is never logged.
//
// Token facts (read from the chain; sources in the spec): AUSD 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC on chainId 84532,
// 6 decimals, EIP-712 domain "Agora Dollar" / "1", transferWithAuthorization(from, to, value, validAfter, validBefore,
// nonce, v, r, s) and authorizationState(authorizer, nonce). We call the (v, r, s) form: the classic EIP-3009 entry point.

import type { AusdAuthorization } from "@rove/db";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  ExecutionRevertedError,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseSignature,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const AUSD_BASE_SEPOLIA_TOKEN = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";

export const AUSD_RELAY_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface AusdRelayerConfig {
  rpcUrl: string;
  token: Address;
  /** Rove's AUSD receive address: every relayed authorization must pay it. */
  payTo: Address;
  relayerPrivateKey: Hex;
  /** Blocks on top of the relay tx before the payment counts as received (2). */
  confirmations: number;
  pollMs: number;
  /** Relay transactions per payment before giving up. */
  maxAttempts: number;
  /** How long a broadcast tx may stay unseen before we sign it again. */
  resendAfterMs: number;
  /** Simulation reverts (estimateGas) per payment before failing it. */
  maxReverts: number;
}

type Env = Record<string, string | undefined>;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Null when AUSD_RELAYER_PRIVATE_KEY isn't set (the relayer stays off). Throws on malformed values. */
export function ausdRelayerConfigFromEnv(env: Env = process.env): AusdRelayerConfig | null {
  const key = env.AUSD_RELAYER_PRIVATE_KEY?.trim();
  if (!key) return null;
  if (!KEY_RE.test(key)) throw new Error("AUSD_RELAYER_PRIVATE_KEY must be 32 bytes of 0x-prefixed hex");
  const payTo = env.AUSD_PAY_TO?.trim();
  if (!payTo || !isAddress(payTo)) throw new Error("AUSD_PAY_TO must be set to Rove's AUSD receive address when the relayer is on");
  const token = env.AUSD_TOKEN_ADDRESS?.trim() || AUSD_BASE_SEPOLIA_TOKEN;
  if (!isAddress(token)) throw new Error(`AUSD_TOKEN_ADDRESS is not an address: ${token}`);
  const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);
  return {
    rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org",
    token: getAddress(token),
    payTo: getAddress(payTo),
    relayerPrivateKey: key as Hex,
    confirmations: 2,
    pollMs: int(env.AUSD_RELAY_POLL_MS, 2000),
    maxAttempts: 5,
    resendAfterMs: 60_000,
    maxReverts: 3,
  };
}

/** signRelay: the transfer would revert on-chain (bad signature, used nonce, payer short of AUSD, paused, frozen …). */
export class RelayRevertedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRevertedError";
  }
}

function isRevert(err: unknown): boolean {
  return err instanceof BaseError && Boolean(err.walk((e) => e instanceof ExecutionRevertedError || e instanceof ContractFunctionRevertedError));
}

export interface RelayReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** The token emitted Transfer(from → to, value) exactly as authorized. */
  transferred: boolean;
}

/** What the relayer needs from the chain. The real one is viem on Base Sepolia; tests pass a fake. */
export interface AusdRelayChain {
  relayer: Address;
  authorizationState(authorizer: Address, nonce: Hex): Promise<boolean>;
  /** Builds, simulates (estimateGas) and signs the relay tx. Does not broadcast. RelayRevertedError if it would revert. */
  signRelay(a: AusdAuthorization): Promise<{ hash: Hex; serialized: Hex }>;
  broadcast(serialized: Hex): Promise<void>;
  getReceipt(hash: Hex, a: AusdAuthorization): Promise<RelayReceipt | null>;
  /** The node knows this tx (pending or mined). */
  txKnown(hash: Hex): Promise<boolean>;
  blockNumber(): Promise<bigint>;
}

/** v, r, s for the (v, r, s) entry point from a 65-byte signature (v 27/28 or yParity 0/1). */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const { r, s, v, yParity } = parseSignature(signature);
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
  return { v: vNum < 27 ? vNum + 27 : vNum, r, s };
}

export function relayCalldata(a: AusdAuthorization): Hex {
  const { v, r, s } = splitSignature(a.signature as Hex);
  return encodeFunctionData({
    abi: AUSD_RELAY_ABI,
    functionName: "transferWithAuthorization",
    args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex, v, r, s],
  });
}

export function createAusdRelayChain(config: AusdRelayerConfig): AusdRelayChain {
  const transport = http(config.rpcUrl, { timeout: 15_000 });
  const account = privateKeyToAccount(config.relayerPrivateKey);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });

  return {
    relayer: account.address,
    authorizationState: (authorizer, nonce) =>
      pub.readContract({ address: config.token, abi: AUSD_RELAY_ABI, functionName: "authorizationState", args: [authorizer, nonce] }),

    async signRelay(a) {
      // prepareTransactionRequest estimates gas (a would-be revert throws here: nothing is signed or sent), picks the
      // pending nonce and EIP-1559 fees for Base Sepolia.
      let request;
      try {
        request = await wallet.prepareTransactionRequest({ account, chain: baseSepolia, to: config.token, data: relayCalldata(a) });
      } catch (err) {
        if (isRevert(err)) throw new RelayRevertedError((err as BaseError).shortMessage);
        throw err;
      }
      const serialized = await wallet.signTransaction(request);
      return { hash: keccak256(serialized), serialized };
    },

    async broadcast(serialized) {
      await pub.sendRawTransaction({ serializedTransaction: serialized });
    },

    async getReceipt(hash, a) {
      let receipt;
      try {
        receipt = await pub.getTransactionReceipt({ hash });
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
      const transfers = parseEventLogs({ abi: AUSD_RELAY_ABI, eventName: "Transfer", logs: receipt.logs });
      const transferred = transfers.some(
        (l) =>
          l.address.toLowerCase() === config.token.toLowerCase() &&
          l.args.from.toLowerCase() === a.from.toLowerCase() &&
          l.args.to.toLowerCase() === a.to.toLowerCase() &&
          l.args.value === BigInt(a.value),
      );
      return { status: receipt.status, blockNumber: receipt.blockNumber, transferred };
    },

    async txKnown(hash) {
      try {
        await pub.getTransaction({ hash });
        return true;
      } catch (err) {
        if (err instanceof TransactionNotFoundError) return false;
        throw err;
      }
    },

    blockNumber: () => pub.getBlockNumber(),
  };
}
