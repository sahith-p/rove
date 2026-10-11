// Errors @rove/db raises on purpose. Re-exported from ./index.

/** Unique-constraint conflicts that callers handle (e.g. a second authorization for the same invoice). */
export class DbConflictError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = "DbConflictError";
  }
}

/** Postgres SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Normalizes driver errors: a unique violation from either driver (postgres.js names the constraint `constraint_name`,
 * PGlite `constraint`) becomes a DbConflictError carrying the constraint name. Everything else passes through.
 */
export function translateError(e: unknown): unknown {
  if (e instanceof DbConflictError) return e;
  if (e && typeof e === "object" && (e as { code?: unknown }).code === UNIQUE_VIOLATION) {
    const err = e as { message?: string; constraint?: string; constraint_name?: string };
    const message = err.message ?? "unique violation";
    const constraint = err.constraint_name ?? err.constraint ?? /constraint "([^"]+)"/.exec(message)?.[1] ?? "unknown";
    return new DbConflictError(message, constraint);
  }
  return e;
}
