// Tiny .env reader/writer for the seed + demo scripts (no dependency). Writes keep comments and order,
// replace keys in place, append new keys, and use mode 0600 (the file holds testnet seeds).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trim();
      if (v.startsWith("#")) v = "";
    }
    out[m[1] as string] = v;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

/** Set `vars` in the file at `path` (created if missing). Keys already present are replaced in place. */
export function upsertEnvFile(path: string, vars: Record<string, string>, header?: string): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : header ? `${header}\n` : "";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(Object.entries(vars));
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i] ?? "");
    if (m && pending.has(m[1] as string)) {
      lines[i] = `${m[1]}=${pending.get(m[1] as string)}`;
      pending.delete(m[1] as string);
    }
  }
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Copy values from env files into process.env without overriding what's already set. First file wins. */
export function loadEnvFiles(paths: string[]): string[] {
  const loaded: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const [k, v] of Object.entries(readEnvFile(p))) {
      if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
    }
    loaded.push(p);
  }
  return loaded;
}

/** The monorepo root: the nearest ancestor of `from` with pnpm-workspace.yaml. */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}
