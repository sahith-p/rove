// createXrplSettlement(): the real SettlementEngine.
//
//   Worker (signs):    createXrplSettlement(xrplConfigFromEnv(), seedStore)   (or { seedStore, log, onTx })
//   Web app (read-only, no seeds): createXrplSettlement(xrplConfigFromEnv())
//     → quote, isVerifiedMerchant, balance and explorerUrl work with public config only;
//       signing methods throw XrplSigningUnavailableError naming the missing env var.

import type { SettlementEngine } from "@rove/shared";
import { closeConnections } from "./client";
import { xrplConfigFromEnv, type XrplConfig } from "./config";
import { createContext, explorerTxUrl, type EngineContext, type EngineOptions } from "./context";
import type { SeedStore } from "./seed-store";
import { quote } from "./quote";
import { settle } from "./settle";

export interface XrplSettlementEngine extends SettlementEngine {
  readonly config: XrplConfig;
  /** For scripts and tests: the context the methods run on. */
  readonly context: EngineContext;
  /** Close the websocket (scripts call this so node can exit). */
  close(): Promise<void>;
}

const notYet = (name: string) => async (): Promise<never> => {
  throw new Error(`${name}: not implemented yet (tasks/nithya.md NI-A4/NI-A5)`);
};

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
    createMerchantAccount: notYet("createMerchantAccount"),
    refund: notYet("refund"),
    sweepToRedemption: notYet("sweepToRedemption"),
    sendToWallet: notYet("sendToWallet"),
    balance: notYet("balance"),
    isVerifiedMerchant: notYet("isVerifiedMerchant"),
    explorerUrl: (txHash) => explorerTxUrl(txHash, config.explorerBase),
    close: async () => {
      if (opts.connection) await opts.connection.close();
      else await closeConnections(config.wss);
    },
  };
}
