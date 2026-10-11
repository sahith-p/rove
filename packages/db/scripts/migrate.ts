// pnpm --filter @rove/db migrate
// Applies packages/db/schema.sql to DATABASE_URL. The schema is idempotent, so this is safe to re-run after every change.

import { readFileSync } from "node:fs";
import { postgresPool } from "../src/executor";
import { databaseUrl, describeUrl } from "./env";

const url = databaseUrl();
const pool = postgresPool(url, { max: 1 });
try {
  // No parameters → postgres.js sends the whole file as one simple-protocol query (multi-statement, one transaction).
  await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const [tables] = await pool.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  console.log(`schema.sql applied to ${describeUrl(url)}: ${tables?.n ?? "?"} tables in public`);
} catch (e) {
  console.error(`migrate failed on ${describeUrl(url)}:`, e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
