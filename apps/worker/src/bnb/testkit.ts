// Test-only helpers for the BNB watcher (NI-C6): an in-memory chain behind ChainSource, and bnb payments inserted the
// way checkout/bnb.ts does it (index from db.nextDepositIndex(), address from the same HD tree, id ending _bsc<n>).

import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { money, newId, type Payment, type Quote } from "@rove/shared";
import { createMockSettlement } from "@rove/shared/mocks";
import type { WorkerDeps } from "../deps";
import { MAYA } from "../settle/testkit";
import { depositKeyring } from "./keys";
import type { ChainSource, TransferLog } from "./source";
import type { WatcherOptions } from "./watcher";

/** The public Hardhat/Anvil test mnemonic: holds nothing, gives well-known addresses. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const keyring = depositKeyring(TEST_MNEMONIC);
export const TEST_TOKEN: Address = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
export const PAYER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

export const ONE = 10n ** 18n;
/** "9.69" → 9.69 × 10^18 base units (18 decimals). */
export const units = (amount: string): bigint => {
  const [w = "0", f = ""] = amount.split(".");
  return BigInt(w) * ONE + BigInt((f + "0".repeat(18)).slice(0, 18));
};

export const WATCH_OPTS: WatcherOptions = { decimals: 18, confirmations: 3, rescanBlocks: 500n, lateGraceMs: 60 * 60_000, symbol: "tUSDT" };

export class FakeChain implements ChainSource {
  id = 97;
  token = { symbol: "tUSDT", decimals: 18 };
  headBlock = 10_000n;
  logs: TransferLog[] = [];
  /** Block timestamps; unset blocks are "now". */
  times = new Map<bigint, Date>();
  calls = { transfers: [] as [bigint, bigint][], blockTime: 0 };
  /** The next N transfers() calls throw (an RPC outage). */
  failTransfers = 0;
  private logIndex = 0;

  async chainId() {
    return this.id;
  }
  async tokenInfo() {
    return this.token;
  }
  async head() {
    return this.headBlock;
  }
  async transfers(fromBlock: bigint, toBlock: bigint) {
    this.calls.transfers.push([fromBlock, toBlock]);
    if (this.failTransfers > 0) {
      this.failTransfers--;
      throw new Error("fetch failed (fake RPC outage)");
    }
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock).map((l) => ({ ...l }));
  }
  async blockTime(blockNumber: bigint) {
    this.calls.blockTime++;
    return this.times.get(blockNumber) ?? new Date();
  }

  /** A Transfer in the next block (or `block`); doesn't advance the head. */
  transfer(to: string, value: bigint, o: { block?: bigint; from?: Address; at?: Date; txHash?: Hex } = {}): TransferLog {
    const blockNumber = o.block ?? this.headBlock + 1n;
    const log: TransferLog = {
      txHash: o.txHash ?? (`0x${randomBytes(32).toString("hex")}` as Hex),
      logIndex: this.logIndex++,
      blockNumber,
      from: o.from ?? PAYER,
      to: to as Address,
      value,
    };
    this.logs.push(log);
    if (o.at) this.times.set(blockNumber, o.at);
    return log;
  }

  /** Advance the head by n blocks. */
  mine(n = 1): void {
    this.headBlock += BigInt(n);
  }
}

export interface BnbPaymentOpts {
  merchantId?: string;
  local?: string;
  invoiceId?: string | null;
  /** Default: a fresh mock quote (S$12.50 → US$9.69, expires in 60 s). */
  quote?: Quote;
}

/** Inserts a `created` bnb payment exactly like checkout/bnb.ts. Returns it with its deposit address. */
export async function bnbPayment(deps: WorkerDeps, o: BnbPaymentOpts = {}): Promise<{ payment: Payment; address: Address; index: number }> {
  const local = money(o.local ?? "12.50", "SGD");
  const quote = o.quote ?? (await createMockSettlement().quote({ local }));
  const index = await deps.db.nextDepositIndex();
  const address = keyring.address(index);
  const payment = await deps.db.insertPayment({
    id: `${newId("pay")}_bsc${index}`,
    merchantId: o.merchantId ?? "ahseng",
    source: o.invoiceId ? "invoice" : "fixed_qr",
    invoiceId: o.invoiceId ?? null,
    lines: [],
    local,
    quote,
    charge: quote.usd,
    method: "bnb",
    payer: MAYA,
    bnbDepositAddress: address,
  });
  return { payment, address, index };
}
