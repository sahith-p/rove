// Recognize and log Stripe SDK errors without leaking keys. Owner: Nithya · Tasks: NI-B2, NI-B3.
// Duck-typed (err.type = "Stripe…Error") so it also works with the fake client in tests.

export interface StripeErrorLike extends Error {
  type: string;
  code?: string;
  statusCode?: number;
  requestId?: string;
}

export function isStripeError(err: unknown): err is StripeErrorLike {
  if (!(err instanceof Error)) return false;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("Stripe");
}

const KEYISH = /\b(sk|rk|pk|whsec)_(test|live)_[A-Za-z0-9*]+/g;

/** Strip anything that looks like a Stripe key or webhook secret (Stripe already masks most of it). */
export function redact(text: string): string {
  return text.replace(KEYISH, "$1_$2_[redacted]");
}

/** One log line for a Stripe failure: type, code, status, request id, redacted message. */
export function describeStripeError(err: unknown): string {
  if (isStripeError(err)) {
    const parts = [err.type, err.code, err.statusCode, err.requestId].filter((v) => v !== undefined && v !== null && v !== "");
    return `${parts.join(" ")}: ${redact(err.message)}`;
  }
  return err instanceof Error ? redact(err.message) : redact(String(err));
}
