// Where the watcher reads BSC from. Owner: Nithya · Task: NI-C6.
// ChainSource is the seam for tests (bnb/testkit.ts has an in-memory chain); createRpcSource is the real one:
// a viem public client over BSC_RPC_URL, eth_getLogs for the token's Transfer events in chunks of maxBlockRange.

import { createPublicClient, erc20Abi, http, parseAbiItem, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import type { BnbConfig } from "./config";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** One ERC-20 Transfer log. `value` is in token base units (bigint, never a float). */
export interface TransferLog {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export interface ChainSource {
  chainId(): Promise<number>;
  tokenInfo(): Promise<{ symbol: string; decimals: number }>;
  /** Latest block number. */
  head(): Promise<bigint>;
  /** The token's Transfer logs in [fromBlock, toBlock], any order. */
  transfers(fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  /** When a block was produced (late-payment rule). */
  blockTime(blockNumber: bigint): Promise<Date>;
}

export function createRpcSource(cfg: Pick<BnbConfig, "rpcUrl" | "token" | "maxBlockRange">): ChainSource {
  const client = createPublicClient({ chain: bscTestnet, transport: http(cfg.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const times = new Map<bigint, Date>();
  const range = cfg.maxBlockRange > 0n ? cfg.maxBlockRange : 1n;

  return {
    chainId: () => client.getChainId(),

    async tokenInfo() {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: cfg.token, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: cfg.token, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { symbol, decimals };
    },

    head: () => client.getBlockNumber({ cacheTime: 0 }),

    async transfers(fromBlock, toBlock) {
      const out: TransferLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += range) {
        const end = start + range - 1n < toBlock ? start + range - 1n : toBlock;
        const logs = await client.getLogs({ address: cfg.token, event: TRANSFER_EVENT, fromBlock: start, toBlock: end, strict: true });
        for (const l of logs) {
          if (l.removed || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
          out.push({ txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber, from: l.args.from, to: l.args.to, value: l.args.value });
        }
      }
      return out;
    },

    async blockTime(blockNumber) {
      const hit = times.get(blockNumber);
      if (hit) return hit;
      const block = await client.getBlock({ blockNumber });
      const at = new Date(Number(block.timestamp) * 1000);
      if (times.size > 500) times.clear();
      times.set(blockNumber, at);
      return at;
    },
  };
}
