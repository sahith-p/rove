// XRPL SettlementEngine. Owner: Nithya. Spec: docs/specs/settlement-xrpl.md
// Implements `SettlementEngine` from @rove/shared. Tasks:
//   NI-A1 client + currency hex helpers + seed encryption + submit queue
//   NI-A2 seed (src/setup.ts, scripts/seed.ts)
//   NI-A3 quote() + settle()                         ← gate G1
//   NI-A4 createMerchantAccount() + isVerifiedMerchant()
//   NI-A5 refund() + sweepToRedemption() + sendToWallet() + balance()
//
// Worker:  createXrplSettlement(xrplConfigFromEnv(), { seedStore })   (seedStore → db.setMerchantXrpl / getMerchantSeedEnc)
// Web app: createXrplSettlement(xrplConfigFromEnv())                  (read-only: quote, isVerifiedMerchant, balance, explorerUrl)

export { createXrplSettlement, type XrplSettlementEngine } from "./engine";
export { xrplConfigFromEnv, type XrplConfig } from "./config";
export { memorySeedStore, envFileSeedStore, type SeedStore } from "./seed-store";
export { explorerTxUrl, explorerAccountUrl, type EngineOptions } from "./context";
export * from "./errors";
export * from "./currency";
export * from "./crypto";
export * from "./queue";
export * from "./client";
export * from "./tx";
export { buildQuote, ammInputForOutput, QUOTE_TTL_MS } from "./quote";
