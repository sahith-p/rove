// Test helpers for @rove/db. Owner: Nithya (NI-B1).
// createTestDb(): an in-process Postgres (PGlite) with packages/db/schema.sql applied, behind the same Db interface,
// so every service's tests run real SQL without a database server or credentials.

import type { Db } from "./index";

export async function createTestDb(): Promise<Db> {
  throw new Error("not implemented: NI-B1");
}
