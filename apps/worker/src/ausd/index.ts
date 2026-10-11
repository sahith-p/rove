// AUSD lane (Agora AUSD on Base Sepolia, gasless for the payer): the worker relayer. Owner: Nithya.
// Spec: docs/specs/ausd-lane.md. Env: AUSD_RELAYER_PRIVATE_KEY (worker only), AUSD_PAY_TO, BASE_SEPOLIA_RPC_URL,
// AUSD_TOKEN_ADDRESS. Without AUSD_RELAYER_PRIVATE_KEY the relayer stays off.

import type { WorkerDeps } from "../deps";
import { errorMessage } from "../settle/xrpl-errors";
import { ausdRelayerConfigFromEnv, createAusdRelayChain } from "./chain";
import { runAusdRelayer } from "./relayer";

export { relayTick, runAusdRelayer, createRelayerState, type RelayStep, type RelayerOptions } from "./relayer";
export { ausdRelayerConfigFromEnv, createAusdRelayChain, RelayRevertedError, type AusdRelayChain, type AusdRelayerConfig } from "./chain";

/** Started by startJobs(). Returns a stopper. */
export function startAusdRelayer(deps: WorkerDeps, env: Record<string, string | undefined> = process.env): () => void {
  const log = deps.log.child("ausd");
  let config;
  try {
    config = ausdRelayerConfigFromEnv(env);
  } catch (err) {
    log.error("AUSD relayer not started: bad config", { err: errorMessage(err) });
    return () => {};
  }
  if (!config) {
    log.debug("AUSD relayer off (AUSD_RELAYER_PRIVATE_KEY not set)");
    return () => {};
  }
  return runAusdRelayer(deps, { config, chain: createAusdRelayChain(config) });
}
