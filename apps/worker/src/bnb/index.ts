// BNB Chain pay-in watcher. Owner: Nithya · Task: NI-C6. Spec: docs/specs/bnb-lane.md.
// Test stablecoin Transfer logs on BSC testnet (chainId 97) → per-payment deposit addresses (db.getPaymentByDepositAddress)
// → 3 confirmations → CAS created → authorized (method bnb, payinTxHash) + claim("bsc:<txHash>:<logIndex>") → settle
// (settle.ts scheduleSettle; the settle poller is the fallback). Core logic: ./watcher.ts. Chain access: ./source.ts.
//
// Env (.env.example): BSC_TOKEN_ADDRESS (unset = watcher off), BSC_TOKEN_DECIMALS, BSC_RPC_URL, BSC_DEPOSIT_MNEMONIC
// (worker only: sweeping later), BSC_DEPOSIT_XPUB (checked against the mnemonic), BSC_POLL_MS, BSC_RESCAN_BLOCKS,
// BSC_LOG_RANGE. Boot refuses to watch the wrong chain or a token whose on-chain decimals differ from the config.

import type { WorkerDeps } from "../deps";
import type { Logger } from "../log";
import { errorMessage } from "../settle/xrpl-errors";
import { BSC_TESTNET_CHAIN_ID, bnbConfigFromEnv, type BnbConfig } from "./config";
import { depositKeyring } from "./keys";
import { createRpcSource, type ChainSource } from "./source";
import { createBnbWatcher } from "./watcher";

export interface StartBnbOptions {
  env?: Record<string, string | undefined>;
  /** Tests pass a fake chain. */
  source?: ChainSource;
  settle?: "now" | "poller";
}

/** Returns a stopper. Never throws: a misconfigured lane is logged and the rest of the worker keeps running. */
export function startBnbWatcher(deps: WorkerDeps, opts: StartBnbOptions = {}): () => void {
  const log = deps.log.child("bnb");
  let cfg: BnbConfig | null;
  try {
    cfg = bnbConfigFromEnv(opts.env);
  } catch (err) {
    log.error("BNB watcher not started: bad config", { err: errorMessage(err) });
    return () => {};
  }
  if (!cfg) {
    log.info("BNB watcher off (BSC_TOKEN_ADDRESS not set)");
    return () => {};
  }
  checkKeys(cfg, log);

  const config = cfg;
  const source = opts.source ?? createRpcSource(config);
  let watcher: ReturnType<typeof createBnbWatcher> | null = null;
  let stopped = false;
  let ticking = false;
  let failures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (!watcher) {
        const checked = await verifyChain(source, config);
        if (!checked.ok) {
          log.error(`BNB watcher not started: ${checked.problem}`);
          stop();
          return;
        }
        watcher = createBnbWatcher(deps, source, { ...config, symbol: checked.symbol, settle: opts.settle });
        log.info("BNB watcher started", { token: config.token, symbol: checked.symbol, decimals: config.decimals, rpc: config.rpcUrl, everyMs: config.pollMs });
      }
      await watcher.poll();
      if (failures) log.info("BSC RPC reachable again", { after: failures });
      failures = 0;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 20 === 0) log.error("BNB watcher poll failed (retrying)", { err: errorMessage(err), failures, hint: hintFor(err) });
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => void tick(), config.pollMs);
  timer.unref?.();
  void tick();
  return stop;
}

async function verifyChain(source: ChainSource, cfg: BnbConfig): Promise<{ ok: true; symbol: string } | { ok: false; problem: string }> {
  const chainId = await source.chainId();
  if (chainId !== BSC_TESTNET_CHAIN_ID) return { ok: false, problem: `BSC_RPC_URL is chain ${chainId}, not BSC testnet (${BSC_TESTNET_CHAIN_ID})` };
  const info = await source.tokenInfo();
  if (info.decimals !== cfg.decimals) {
    return {
      ok: false,
      problem: `BSC_TOKEN_DECIMALS=${cfg.decimals} but ${info.symbol} at ${cfg.token} has ${info.decimals} decimals: amounts would be off by 10^${Math.abs(info.decimals - cfg.decimals)}`,
    };
  }
  return { ok: true, symbol: info.symbol };
}

/** The web derives deposit addresses from the xpub; the worker must hold the matching mnemonic to sweep them. */
function checkKeys(cfg: BnbConfig, log: Logger): void {
  if (!cfg.mnemonic) {
    log.warn("BSC_DEPOSIT_MNEMONIC not set: deposits are detected, but this worker can't sweep them");
    return;
  }
  try {
    const { xpub } = depositKeyring(cfg.mnemonic);
    if (cfg.xpub && cfg.xpub !== xpub) {
      log.error("BSC_DEPOSIT_XPUB doesn't match BSC_DEPOSIT_MNEMONIC: the web hands out deposit addresses this worker can't sweep. Re-run scripts/bsc-setup.ts or fix the env");
    }
  } catch (err) {
    log.error("BSC_DEPOSIT_MNEMONIC can't be used", { err: errorMessage(err) });
  }
}

function hintFor(err: unknown): string | undefined {
  const msg = errorMessage(err);
  if (/limit exceeded/i.test(msg)) return "this RPC refuses eth_getLogs (the bnbchain.org data-seed nodes do); use BSC_RPC_URL=https://bsc-testnet-rpc.publicnode.com";
  if (/range|too many|block range/i.test(msg)) return "lower BSC_LOG_RANGE";
  return undefined;
}
