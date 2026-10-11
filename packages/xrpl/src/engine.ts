// createXrplSettlement(): the real SettlementEngine.
//
//   Worker (signs):    createXrplSettlement(xrplConfigFromEnv(), seedStore)   (or { seedStore, log, onTx })
//   Web app (read-only, no seeds): createXrplSettlement(xrplConfigFromEnv())
//     → quote, isVerifiedMerchant, balance and explorerUrl work with public config only;
//       signing methods throw XrplSigningUnavailableError naming the missing env var.

import type { Money, SettlementEngine } from "@rove/shared";
import { xsgdBalance } from "./balance";
import { closeConnections } from "./client";
import { xrplConfigFromEnv, type XrplConfig } from "./config";
import { createContext, explorerTxUrl, type EngineContext, type EngineOptions } from "./context";
import type { XrplDestinationError } from "./errors";
import { createMerchantAccount, isVerifiedMerchant } from "./merchant";
import { quote } from "./quote";
import { refund } from "./refund";
import type { SeedStore } from "./seed-store";
import { settle } from "./settle";
import { checkWalletDestination, sendToWallet, sweepToRedemption } from "./withdraw";

export interface XrplSettlementEngine extends SettlementEngine {
  readonly config: XrplConfig;
  /** For scripts and tests: the context the methods run on. */
  readonly context: EngineContext;
  /**
   * Read-only pre-check for a wallet withdrawal (withdrawals.md §3a): null if `address` can receive `local` XSGD,
   * else an XrplDestinationError whose message the agent can say to the merchant.
   */
  checkWalletDestination(input: { address: string; local: Money; merchantAddress?: string }): Promise<XrplDestinationError | null>;
  /** Close the websocket (scripts call this so node can exit). */
  close(): Promise<void>;
}

function isSeedStore(x: unknown): x is SeedStore {
  return typeof x === "object" && x !== null && typeof (x as SeedStore).put === "function" && typeof (x as SeedStore).get === "function";
}

/** `seeds`: the worker's SeedStore, or EngineOptions ({ seedStore, log, onTx, … }). Omit it for read-only use. */
export function createXrplSettlement(config: XrplConfig = xrplConfigFromEnv(), seeds?: SeedStore | EngineOptions): XrplSettlementEngine {
  const opts: EngineOptions = isSeedStore(seeds) ? { seedStore: seeds } : (seeds ?? {});
  const ctx = createContext(config, opts);
  return {
    config,
    context: ctx,
    quote: ({ local }) => quote(ctx, local),
    settle: (input) => settle(ctx, input),
    createMerchantAccount: ({ merchantId }) => createMerchantAccount(ctx, merchantId),
    refund: (input) => refund(ctx, input),
    sweepToRedemption: (input) => sweepToRedemption(ctx, input),
    sendToWallet: (input) => sendToWallet(ctx, input),
    balance: ({ merchantAddress }) => xsgdBalance(ctx, merchantAddress),
    isVerifiedMerchant: (address) => isVerifiedMerchant(ctx, address),
    explorerUrl: (txHash) => explorerTxUrl(txHash, config.explorerBase),
    checkWalletDestination: (input) => checkWalletDestination(ctx, input),
    close: async () => {
      if (opts.connection) await opts.connection.close();
      else await closeConnections(config.wss);
    },
  };
}
