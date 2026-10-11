// XRPL SettlementEngine. Owner: Nithya. Spec: docs/specs/settlement-xrpl.md
// Implements `SettlementEngine` from @rove/shared. Tasks:
//   NI-A1 client + currency hex helpers + seed encryption + submit queue
//   NI-A2 seed (src/setup.ts, scripts/seed.ts)
//   NI-A3 quote() + settle()                         ← gate G1
//   NI-A4 createMerchantAccount() + isVerifiedMerchant()
//   NI-A5 refund() + sweepToRedemption() + sendToWallet() + balance()

import type { SettlementEngine } from "@rove/shared";

export * from "./currency";
export * from "./crypto";
export * from "./queue";
export * from "./client";
export * from "./config";
export * from "./errors";
export * from "./tx";
export { memorySeedStore, envFileSeedStore, type SeedStore } from "./seed-store";
export { explorerTxUrl, explorerAccountUrl, type EngineOptions } from "./context";

export function createXrplSettlement(): SettlementEngine {
  throw new Error("not implemented: see tasks/nithya.md NI-A3..NI-A5");
}
