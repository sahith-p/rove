// DATABASE_URL for the scripts: the environment first, else the repo-root .env (never printed).

import { existsSync } from "node:fs";

export function databaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    const rootEnv = new URL("../../../.env", import.meta.url);
    if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Put it in the repo-root .env or the environment (Supabase → Connect → Transaction pooler).");
    process.exit(1);
  }
  return url;
}

/** host:port/db, without credentials, for logs. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
