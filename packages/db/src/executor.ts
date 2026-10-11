// The tiny SQL surface the Db implementation runs on, so production (postgres.js) and tests (PGlite) execute the same SQL.
// Parameters are limited to primitives; arrays and objects go in as JSON text cast in SQL as `$1::text::jsonb`.
// (Not `$1::jsonb`: postgres.js JSON.stringify's json/jsonb-typed params, double-encoding a string. The test adapter
// mimics that, see pglite.ts.) Numerics come back as strings (never floats), timestamps as Date.

import postgres from "postgres";
import { translateError } from "./errors";

export type Param = string | number | boolean | null;
export type Row = Record<string, unknown>;

/** postgres.js rejects `undefined` parameters; an optional field left out means NULL. */
export const bindable = (params: readonly (Param | undefined)[]): Param[] => params.map((p) => (p === undefined ? null : p));

export interface Executor {
  query<T extends Row = Row>(text: string, params?: readonly Param[]): Promise<T[]>;
}

export interface Pool extends Executor {
  /** Runs `fn` in one transaction (BEGIN … COMMIT, ROLLBACK on throw). Use only the executor it hands you inside. */
  tx<T>(fn: (q: Executor) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface PostgresPoolOptions {
  /** Max connections in this process's pool. Default 5. */
  max?: number;
  /** Session search_path (tests isolate each run in its own schema). */
  searchPath?: string;
}

/** postgres.js over a connection string. `prepare: false` because the Supabase transaction pooler can't keep prepared statements. */
export function postgresPool(url: string, opts: PostgresPoolOptions = {}): Pool {
  const sql = postgres(url, {
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    ...(opts.searchPath ? { connection: { search_path: opts.searchPath } } : {}),
  });
  const executor = (s: postgres.Sql | postgres.TransactionSql): Executor => ({
    async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = await s.unsafe(text, bindable(params) as any[]);
        return Array.from(rows) as unknown as T[]; // a plain array, not postgres.js's Result subclass
      } catch (e) {
        throw translateError(e);
      }
    },
  });
  return {
    ...executor(sql),
    async tx<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
      try {
        return (await sql.begin((t) => fn(executor(t)))) as T;
      } catch (e) {
        throw translateError(e);
      }
    },
    async end() {
      await sql.end({ timeout: 5 });
    },
  };
}
