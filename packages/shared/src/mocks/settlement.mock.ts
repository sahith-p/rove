// Mock SettlementEngine (USE_MOCK_SETTLEMENT=1). Lets web/agent/worker work before gate G1.
// Fixed rates against the USD hub (1.2900 SGD, 0.9259 EUR per USD), 1% slippage, fake tx hashes, ~1.5s "ledger close".
// Any enabled pair works like the real engine: quote({ local, from }), settle({ from }), balances per currency.
// Without `from`, quote() returns exactly the original USD-route shape (no pay/sendMax), so existing callers see no change.

import { randomBytes } from "node:crypto";
import { currencyInfo, type Currency } from "../currencies";
import { DECIMALS, fromMinor, fromUnits, toMinor, type Money } from "../money";
import type { Quote } from "../domain";
import type { SettleResult, SettlementEngine } from "../settlement";

/** Local currency units per 1 USD, at 4 decimals. */
const PER_USD: Record<Currency, bigint> = { USD: 10000n, SGD: 12900n, EUR: 9259n };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeHash = () => randomBytes(32).toString("hex").toUpperCase();
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const pow10 = (n: number) => 10n ** BigInt(n);

/** Minor units of `to` that buy `minor` minor units of `from`'s amount at the fixed rates, rounded up. */
function convertCeil(minor: bigint, from: Currency, to: Currency): bigint {
  if (from === to) return minor;
  // value_to = value_from × PER_USD[to] / PER_USD[from], in each currency's minor units.
  return ceilDiv(minor * PER_USD[to] * pow10(DECIMALS[to]), PER_USD[from] * pow10(DECIMALS[from]));
}

/** local per 1 `from`, 4 decimals, floored. */
function rateOf(local: Currency, from: Currency): string {
  return fromUnits((PER_USD[local] * 10000n) / PER_USD[from], 4);
}

export function createMockSettlement(): SettlementEngine {
  const balances = new Map<string, Map<Currency, bigint>>(); // merchantAddress → currency → minor units
  const accountCurrency = new Map<string, Currency>();
  let ledger = 1_000_000;
  const get = (addr: string, c: Currency) => balances.get(addr)?.get(c) ?? 0n;
  const set = (addr: string, c: Currency, v: bigint) => {
    const m = balances.get(addr) ?? new Map<Currency, bigint>();
    m.set(c, v);
    balances.set(addr, m);
  };
  const debit = (addr: string, m: Money) => {
    const cur = get(addr, m.currency);
    if (cur < toMinor(m)) throw new Error(`tecUNFUNDED_PAYMENT (mock): insufficient ${currencyInfo(m.currency).stablecoin?.xrplCode ?? m.currency}`);
    set(addr, m.currency, cur - toMinor(m));
  };

  return {
    async quote({ local, from }): Promise<Quote> {
      const lc = local.currency;
      const localMinor = toMinor(local);
      const usdMinor = convertCeil(localMinor, lc, "USD");
      const usdSendMax = lc === "USD" ? usdMinor : ceilDiv(usdMinor * 101n, 100n);
      const base: Quote = {
        local,
        usd: fromMinor(usdMinor, "USD"),
        rate: rateOf(lc, "USD"),
        sendMaxUsd: fromUnits(usdSendMax, DECIMALS.USD),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      if (!from) return base;
      const payMinor = convertCeil(localMinor, lc, from);
      const sendMax = from === lc ? payMinor : ceilDiv(payMinor * 101n, 100n);
      return { ...base, rate: rateOf(lc, from), pay: fromMinor(payMinor, from), sendMax: fromUnits(sendMax, DECIMALS[from]) };
    },

    async createMerchantAccount({ merchantId, currency }) {
      await sleep(800);
      const xrplAddress = `rMOCK${merchantId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)}`;
      const c = currency ?? "SGD";
      accountCurrency.set(xrplAddress, c);
      set(xrplAddress, c, 0n);
      return { xrplAddress, credentialStatus: "accepted" };
    },

    async settle({ merchantAddress, local }): Promise<SettleResult> {
      await sleep(1500);
      if (process.env.MOCK_SETTLE_FAIL === "1") throw new Error("tecPATH_PARTIAL (mock)");
      set(merchantAddress, local.currency, get(merchantAddress, local.currency) + toMinor(local));
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

    async balance({ merchantAddress, currency }): Promise<Money> {
      const c = currency ?? accountCurrency.get(merchantAddress) ?? "SGD";
      return fromMinor(get(merchantAddress, c), c);
    },

    async isVerifiedMerchant(address) {
      return address.startsWith("rMOCK");
    },

    explorerUrl(txHash) {
      return `https://testnet.xrpl.org/transactions/${txHash}`;
    },
  };
}
