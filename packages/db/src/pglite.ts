// PGlite adapter for the executor (tests only; PGlite is a devDependency, so only ./testing imports this file).
// PGlite runs every top-level query and transaction behind one mutex, which serializes them like row locks would.

import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
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
