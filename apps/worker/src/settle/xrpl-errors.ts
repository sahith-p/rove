// What an error from the SettlementEngine means for money: did the XRPL transaction certainly NOT move funds?
// Used by settle (NI-C2) and refunds (NI-C5) to decide between retry, clean failure, and "park it for review".
// Understands both the real engine's typed errors (@rove/xrpl errors.ts) and the mock's plain `Error("tecPATH_PARTIAL …")`.
//
//   path        tecPATH_PARTIAL / tecPATH_DRY / SendMax pre-flight (isRequoteError), or an expired quote:
//               nothing moved; re-quote and retry
//   retry       not applied, safe to resend (XrplTxError.retryable, tefPAST_SEQ & co): retry
//   mismatch    applied, but delivered ≠ the amount asked for (DELIVERED_MISMATCH): money moved; never credit, fail loudly
//   definitive  any other tec / tef / tem / tel result, or an error raised before signing/submitting
//               (ValidationError, NotConnectedError, signing unavailable, `err.submitted === false`): nothing moved
//   ambiguous   anything else (TIMEOUT, disconnects mid-wait, ter* results, unknown errors): the transaction MAY have
//               been applied. Never retry or refund automatically: that could pay twice. Leave the row for review.

import { isRequoteError, XrplTxError } from "@rove/xrpl";

export type XrplErrorKind = "path" | "retry" | "mismatch" | "definitive" | "ambiguous";

export interface ClassifiedError {
  kind: XrplErrorKind;
  /** XRPL engine result (or the engine's local code), e.g. "tecPATH_DRY", "TIMEOUT". */
  code: string | null;
  message: string;
  /** Set when the engine reports the transaction it got validated. */
  txHash?: string;
}

const RESULT_RE = /\b(?:tec|tef|tem|tel|ter)[A-Z][A-Z_]+\b/;
const PATH_CODES = new Set(["tecPATH_PARTIAL", "tecPATH_DRY"]);
const RETRY_CODES = new Set(["tefPAST_SEQ", "tefMAX_LEDGER", "telINSUF_FEE_P", "telCAN_NOT_QUEUE", "telCAN_NOT_QUEUE_FULL"]);
/** The engine's own codes meaning "we can't tell whether it was applied". */
const UNKNOWN_CODES = new Set(["TIMEOUT", "NO_DELIVERED_AMOUNT"]);
/** Thrown before anything is signed or sent. */
const PRE_SUBMIT_NAMES = new Set(["ValidationError", "NotConnectedError", "XrplSigningUnavailableError", "XrplDestinationError"]);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function findCode(err: unknown, message: string): string | null {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const data = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
    for (const v of [e.code, e.result, e.engineResult, e.engine_result, data.engine_result, data.error]) {
      if (typeof v === "string") {
        const m = RESULT_RE.exec(v);
        if (m) return m[0];
      }
    }
  }
  return RESULT_RE.exec(message)?.[0] ?? null;
}

export function classifyXrplError(err: unknown): ClassifiedError {
  const message = errorMessage(err);

  if (err instanceof XrplTxError) {
    const base = { code: err.code, message, ...(err.txHash ? { txHash: err.txHash } : {}) };
    if (isRequoteError(err)) return { kind: "path", ...base };
    if (err.code === "DELIVERED_MISMATCH") return { kind: "mismatch", ...base };
    if (UNKNOWN_CODES.has(err.code)) return { kind: "ambiguous", ...base };
    if (err.retryable) return { kind: "retry", ...base };
    if (RESULT_RE.test(err.code) && !err.code.startsWith("ter")) return { kind: "definitive", ...base };
    return { kind: "ambiguous", ...base };
  }

  const code = findCode(err, message);
  const e = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  if (code && PATH_CODES.has(code)) return { kind: "path", code, message };
  if (code && RETRY_CODES.has(code)) return { kind: "retry", code, message };
  if (/quote.{0,20}expired|expired.{0,20}quote/i.test(message)) return { kind: "path", code, message };
  if (code && !code.startsWith("ter")) return { kind: "definitive", code, message };
  if (e.submitted === false) return { kind: "definitive", code, message };
  if (typeof e.name === "string" && PRE_SUBMIT_NAMES.has(e.name)) return { kind: "definitive", code, message };
  return { kind: "ambiguous", code, message };
}
