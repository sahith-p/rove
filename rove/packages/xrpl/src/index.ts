// XRPL SettlementEngine. Owner: Nithya. Spec: docs/specs/settlement-xrpl.md
// Implements `SettlementEngine` from @rove/shared. Tasks:
//   NI-A1 client + currency hex helpers + seed encryption + submit queue
//   NI-A3 quote() + settle()                         ← gate G1
//   NI-A4 createMerchantAccount() + isVerifiedMerchant()
//   NI-A5 refund() + sweepToRedemption() + sendToWallet() + balance()

import type { SettlementEngine } from "@rove/shared";

export function createXrplSettlement(): SettlementEngine {
  throw new Error("not implemented: see tasks/nithya.md NI-A1..NI-A5");
}
