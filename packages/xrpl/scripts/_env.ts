// Env loading for the xrpl scripts. .env.seed lives at the repo root (override with ROVE_ENV_SEED).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WSS } from "../src/client";
import { findRepoRoot, loadEnvFiles } from "../src/envfile";

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
export const ENV_SEED_PATH = process.env.ROVE_ENV_SEED || join(REPO_ROOT, ".env.seed");
/** The app .env (override with ROVE_DOTENV, e.g. from a git worktree that has no .env of its own). */
export const DOTENV_PATH = process.env.ROVE_DOTENV || join(REPO_ROOT, ".env");

/** Load .env.seed then .env into process.env (existing values win; .env.seed beats .env). */
export function loadScriptEnv(opts: { includeSeedFile?: boolean } = {}): string[] {
  const files = opts.includeSeedFile === false ? [DOTENV_PATH] : [ENV_SEED_PATH, DOTENV_PATH];
  return loadEnvFiles(files);
}

/** Refuse anything that isn't a test network. */
export function testnetWss(): string {
  const wss = process.env.XRPL_WSS || DEFAULT_WSS;
  const host = new URL(wss).hostname;
  if (!/altnet|testnet|devnet|^localhost$|^127\.0\.0\.1$/.test(host)) {
    throw new Error(`refusing to run against ${wss}: these scripts are for XRPL testnet only`);
  }
  return wss;
}
