// Typed errors the worker can branch on (settlement-xrpl.md §4).
//   XrplPathError         tecPATH_PARTIAL / tecPATH_DRY → re-quote and retry (then fail + Stripe auto-refund)
//   XrplNoTrustLineError  tecNO_LINE & co → the account needs a trust line
//   XrplTxError           any other non-success result (code = engine result)
//   XrplSigningUnavailableError  a signing method was called without its seed (read-only deployment)
//   XrplDestinationError  sendToWallet: the merchant's wallet can't receive XSGD yet (message is merchant-readable)

export const PATH_CODES = new Set(["tecPATH_PARTIAL", "tecPATH_DRY"]);
export const NO_LINE_CODES = new Set(["tecNO_LINE", "tecNO_LINE_INSUF_RESERVE", "tecNO_AUTH", "terNO_LINE"]);

export class XrplTxError extends Error {
  override name = "XrplTxError";
  /** Engine result, e.g. "tecUNFUNDED_PAYMENT", or a local code like "EXPIRED" / "DELIVERED_MISMATCH". */
  readonly code: string;
  readonly txHash?: string;
  /** Safe to retry as-is (the tx was not applied). */
  readonly retryable: boolean;
  constructor(code: string, message: string, opts: { txHash?: string; retryable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.txHash = opts.txHash;
    this.retryable = opts.retryable ?? false;
  }
  /** The worker should get a fresh quote and try again. */
  get requote(): boolean {
    return PATH_CODES.has(this.code);
  }
}

export class XrplPathError extends XrplTxError {
  override name = "XrplPathError";
  constructor(code: string, message: string, opts: { txHash?: string } = {}) {
    super(code, message, { ...opts, retryable: true });
  }
}

export class XrplNoTrustLineError extends XrplTxError {
  override name = "XrplNoTrustLineError";
}

export class XrplSigningUnavailableError extends Error {
  override name = "XrplSigningUnavailableError";
}

export class XrplDestinationError extends Error {
  override name = "XrplDestinationError";
  constructor(
    message: string,
    readonly reason: "no_account" | "no_trust_line" | "trust_line_limit" | "same_account" | "invalid_address",
  ) {
    super(message);
  }
}

/**
 * createMerchantAccount: the account and trust lines are ready, but the network rejected the Credential
 * (temDISABLED: the Credentials amendment is off). The worker should keep `xrplAddress` and use its DB flag instead.
 */
export class XrplCredentialsUnavailableError extends Error {
  override name = "XrplCredentialsUnavailableError";
  constructor(
    message: string,
    readonly xrplAddress: string,
  ) {
    super(message);
  }
}

/** Should the worker re-quote and retry this settle? */
export function isRequoteError(err: unknown): boolean {
  return err instanceof XrplTxError && err.requote;
}

/** Map a final (validated) engine result to the right error class. */
export function txErrorFor(code: string, what: string, txHash?: string): XrplTxError {
  if (PATH_CODES.has(code)) {
    return new XrplPathError(code, `${what} failed: ${code} (not enough liquidity within SendMax; re-quote and retry)`, { txHash });
  }
  if (NO_LINE_CODES.has(code)) {
    return new XrplNoTrustLineError(code, `${what} failed: ${code} (an account is missing the trust line for this token)`, { txHash });
  }
  const hint: Record<string, string> = {
    tecUNFUNDED_PAYMENT: "the sender doesn't hold enough of this token",
    tecNO_DST: "the destination account doesn't exist",
    tecNO_DST_INSUF_XRP: "the destination account doesn't exist and the XRP sent is below the reserve",
    tecINSUFFICIENT_RESERVE: "the account doesn't have enough XRP for the reserve",
    tecDST_TAG_NEEDED: "the destination requires a destination tag",
    tecDUPLICATE: "this ledger object already exists",
    temDISABLED: "the feature (amendment) is not enabled on this network",
  };
  return new XrplTxError(code, `${what} failed: ${code}${hint[code] ? ` (${hint[code]})` : ""}`, { txHash });
}
