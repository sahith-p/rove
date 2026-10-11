// Test helpers for @rove/db. Owner: Nithya (NI-B1).
// createTestDb(): an in-process Postgres (PGlite) with packages/db/schema.sql applied, behind the same Db interface,
// so every service's tests run real SQL without a database server or credentials.

import { seedDemoData, seedEurDemoData } from "./demo";
import { makeDb } from "./impl";
import type { Db } from "./index";
import { freshPglite, pglitePool } from "./pglite";

export interface TestDbOptions {
  /** Also upsert DEMO_MERCHANT (live), DEMO_MENU and DEMO_CONTACTS from @rove/shared/mocks with their fixture ids. */
  demo?: boolean;
  /** Also upsert the EUR demo shop cafe-berlin (DEMO_EUR_MERCHANT, live, no XRPL account) and DEMO_EUR_MENU. */
  eurDemo?: boolean;
}

/** A fresh, empty database (its own in-memory PGlite, ~130 ms). Call `close()` when done. */
export async function createTestDb(opts: TestDbOptions = {}): Promise<Db> {
  const pool = pglitePool(await freshPglite());
  if (opts.demo) await seedDemoData(pool);
  if (opts.eurDemo) await seedEurDemoData(pool);
  return makeDb(pool);
}
