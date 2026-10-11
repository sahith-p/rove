// Mock SettlementEngine (USE_MOCK_SETTLEMENT=1). Lets web/agent/worker work before gate G1.
// Fixed rate 1.2900 SGD per USD, 1% slippage, fake tx hashes, ~1.5s "ledger close".

import { randomBytes } from "node:crypto";
import { fromMinor, fromUnits, toMinor, type Money } from "../money";
import type { Quote } from "../domain";
import type { SettleResult, SettlementEngine } from "../settlement";

const RATE_UNITS = 12900n; // 1.2900 at 4 decimals
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeHash = () => randomBytes(32).toString("hex").toUpperCase();
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function createMockSettlement(): SettlementEngine {
  const balances = new Map<string, bigint>(); // merchantAddress → XSGD cents
  let ledger = 1_000_000;
  const debit = (addr: string, m: Money) => {
    const cur = balances.get(addr) ?? 0n;
    if (cur < toMinor(m)) throw new Error("tecUNFUNDED_PAYMENT (mock): insufficient XSGD");
    balances.set(addr, cur - toMinor(m));
  };

  return {
    async quote({ local }): Promise<Quote> {
      const usdCents = ceilDiv(toMinor(local) * 10_000n, RATE_UNITS);
      const sendMax = ceilDiv(usdCents * 101n, 100n);
      return {
        local,
        usd: fromMinor(usdCents, "USD"),
        rate: fromUnits(RATE_UNITS, 4),
        sendMaxUsd: fromUnits(sendMax, 2),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },

    async createMerchantAccount({ merchantId }) {
      await sleep(800);
      const xrplAddress = `rMOCK${merchantId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)}`;
      balances.set(xrplAddress, 0n);
      return { xrplAddress, credentialStatus: "accepted" };
    },

    async settle({ merchantAddress, local }): Promise<SettleResult> {
      await sleep(1500);
      if (process.env.MOCK_SETTLE_FAIL === "1") throw new Error("tecPATH_PARTIAL (mock)");
      balances.set(merchantAddress, (balances.get(merchantAddress) ?? 0n) + toMinor(local));
      return { txHash: fakeHash(), delivered: local.amount, ledgerIndex: ++ledger };
    },

    async refund({ merchantAddress, local }) {
      await sleep(1500);
      debit(merchantAddress, local);
      return { txHash: fakeHash() };
    },

    async sweepToRedemption({ merchantAddress, local }) {
      await sleep(1200);
      debit(merchantAddress, local);
      return { txHash: fakeHash() };
    },

    async sendToWallet({ merchantAddress, local }) {
      await sleep(1200);
      debit(merchantAddress, local);
      return { txHash: fakeHash() };
    },

    async balance({ merchantAddress }): Promise<Money> {
      return fromMinor(balances.get(merchantAddress) ?? 0n, "SGD");
    },

    async isVerifiedMerchant(address) {
      return address.startsWith("rMOCK");
    },

    explorerUrl(txHash) {
      return `https://testnet.xrpl.org/transactions/${txHash}`;
    },
  };
}
