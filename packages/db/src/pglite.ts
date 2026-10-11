// PGlite adapter for the executor (tests only; PGlite is a devDependency, so only ./testing and tests import this file).
// PGlite runs every top-level query and transaction behind one mutex, which serializes them like row locks would.

import { readFileSync } from "node:fs";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { translateError } from "./errors";
import type { Executor, Param, Pool, Row } from "./executor";

export function pglitePool(pg: PGliteInterface): Pool {
  const executor = (s: PGliteInterface | Transaction): Executor => ({
    async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
      try {
        return (await s.query<T>(text, params as Param[])).rows;
      } catch (e) {
        throw translateError(e);
      }
    },
  });
  return {
    ...executor(pg),
    async tx<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
      try {
        return await pg.transaction((t) => fn(executor(t)));
      } catch (e) {
        throw translateError(e);
      }
    },
    async end() {
      if (!pg.closed) await pg.close();
    },
  };
}

/** packages/db/schema.sql */
export function schemaSql(): string {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

// The schema is applied once per process and snapshotted; each test database boots from the snapshot (~4x faster
// than re-applying). The template instance is closed right away: an open PGlite keeps the process alive ~10s.
let snapshot: Promise<File | Blob> | undefined;

/**
 * Serialize parameters the way postgres.js (production) does, so driver differences fail here instead of in deploys.
 * postgres.js JSON.stringify's any parameter the server infers as json/jsonb, even a string; PGlite passes strings
 * through. Hence the SQL casts JSON text params as `$n::text::jsonb`, never `$n::jsonb`.
 */
export const POSTGRES_JS_SERIALIZERS = {
  114: (x: unknown) => JSON.stringify(x),
  3802: (x: unknown) => JSON.stringify(x),
  16: (x: unknown) => (x === true ? "t" : "f"),
  1184: (x: unknown) => (x instanceof Date ? x : new Date(x as string)).toISOString(),
};

/** A fresh in-memory Postgres with schema.sql applied. */
export async function freshPglite(): Promise<PGliteInterface> {
  snapshot ??= (async () => {
    const pg = await PGlite.create();
    try {
      await pg.exec(schemaSql());
      return await pg.dumpDataDir("none");
    } finally {
      await pg.close();
    }
  })();
  return PGlite.create({ loadDataDir: await snapshot, serializers: POSTGRES_JS_SERIALIZERS });
}
