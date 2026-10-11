// BNB Chain pay-in watcher. Owner: Nithya · Task: NI-C6 (stub from NI-C1). Spec: docs/specs/bnb-lane.md.
// viem watcher on BSC testnet for test-USDT Transfer logs to per-payment deposit addresses (db.getPaymentByDepositAddress),
// 3 confirmations, db.claim("bsc:<txHash>:<logIndex>"), CAS created → authorized (method bnb), then settle (../settle.ts).
// Put helpers in this folder (bnb/*.ts); config from env (BSC_RPC_URL, BSC_TOKEN_ADDRESS, BSC_TOKEN_DECIMALS, BSC_DEPOSIT_MNEMONIC).

import type { WorkerDeps } from "../deps";

/** Returns a stopper. */
export function startBnbWatcher(deps: WorkerDeps): () => void {
  deps.log.debug("BNB watcher not started (NI-C6)");
  return () => {};
}
