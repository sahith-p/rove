// Test helpers for @rove/db. Owner: Nithya (NI-B1).
// createTestDb(): an in-process Postgres (PGlite) with packages/db/schema.sql applied, behind the same Db interface,
// so every service's tests run real SQL without a database server or credentials.

import { readFileSync } from "node:fs";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { seedDemoData } from "./demo";
import { makeDb } from "./impl";
import type { Db } from "./index";
import { pglitePool } from "./pglite";

export interface TestDbOptions {
  /** Also upsert DEMO_MERCHANT (live), DEMO_MENU and DEMO_CONTACTS from @rove/shared/mocks with their fixture ids. */
  demo?: boolean;
}

/** packages/db/schema.sql */
export function schemaSql(): string {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

// One schema-applied instance per process; each test db is a clone of it (~4x faster than applying the schema again).
let template: Promise<PGliteInterface> | undefined;
function schemaTemplate(): Promise<PGliteInterface> {
  template ??= (async () => {
    const pg = await PGlite.create();
    await pg.exec(schemaSql());
    return pg;
  })();
  return template;
}

/** A fresh, empty database (its own PGlite instance). Call `close()` when done. */
export async function createTestDb(opts: TestDbOptions = {}): Promise<Db> {
  const pg = await (await schemaTemplate()).clone();
  const pool = pglitePool(pg);
  if (opts.demo) await seedDemoData(pool);
  return makeDb(pool);
}
