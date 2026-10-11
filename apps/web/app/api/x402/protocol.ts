// x402 protocol v2 types and header codecs (https://github.com/coinbase/x402: specs/x402-specification-v2.md,
// specs/transports-v2/http.md, specs/schemes/exact/scheme_exact_evm.md). Owner: Nithya · Spec: docs/specs/ausd-lane.md §x402.
//
// HTTP transport v2: 402 + `PAYMENT-REQUIRED` (base64 JSON PaymentRequired) → client retries with `PAYMENT-SIGNATURE`
// (base64 JSON PaymentPayload) → server answers with `PAYMENT-RESPONSE` (base64 JSON SettlementResponse).
// v1 clients used `X-PAYMENT` / `X-PAYMENT-RESPONSE`; we accept `X-PAYMENT` carrying a v2 payload and mirror the response
// header under both names. v1 payloads (x402Version 1) are refused with a clear 400.

import { z } from "zod";

export const X402_VERSION = 2 as const;

export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
  legacyPayment: "X-PAYMENT",
  legacyResponse: "X-PAYMENT-RESPONSE",
} as const;

const Hex = (bytes?: number) =>
  z.string().regex(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/, bytes ? `${bytes}-byte hex` : "hex");
const Uint = z.string().regex(/^\d{1,78}$/, "uint256 decimal string");

export const PaymentRequirementsZ = z.object({
  scheme: z.string(),
  network: z.string(),
  amount: Uint,
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsZ>;

export const ResourceInfoZ = z.object({ url: z.string(), description: z.string().optional(), mimeType: z.string().optional() });

export const PaymentRequiredZ = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfoZ,
  accepts: z.array(PaymentRequirementsZ).min(1),
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredZ>;

/** `exact` scheme on EVM, EIP-3009 transfer method. */
export const ExactEvmPayloadZ = z.object({
  signature: Hex(65),
  authorization: z.object({
    from: Hex(20),
    to: Hex(20),
    value: Uint,
    validAfter: Uint,
    validBefore: Uint,
    nonce: Hex(32),
  }),
});

export const PaymentPayloadZ = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfoZ.optional(),
  accepted: PaymentRequirementsZ,
  payload: ExactEvmPayloadZ,
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadZ>;

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
}

/** Error reasons, named like the x402 reference facilitator's. */
export type X402ErrorReason =
  | "invalid_payload"
  | "unsupported_scheme"
  | "invalid_network"
  | "invalid_payment_requirements"
  | "quote_expired"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_exact_evm_payload_authorization_value"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_authorization_nonce_used"
  | "insufficient_funds"
  | "settlement_failed";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader(value: string): unknown {
  const text = Buffer.from(value.trim(), "base64").toString("utf8");
  return JSON.parse(text);
}

export type DecodedPayment = { ok: true; payment: PaymentPayload } | { ok: false; message: string };

/** The payment header (PAYMENT-SIGNATURE, or legacy X-PAYMENT), decoded and validated. Null when neither is present. */
export function readPaymentHeader(req: Request): DecodedPayment | null {
  const raw = req.headers.get(X402_HEADERS.signature) ?? req.headers.get(X402_HEADERS.legacyPayment);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = decodeHeader(raw);
  } catch {
    return { ok: false, message: "The payment header must be base64-encoded JSON." };
  }
  if (json && typeof json === "object" && (json as { x402Version?: unknown }).x402Version === 1) {
    return { ok: false, message: "x402Version 1 payloads aren't supported here: send an x402Version 2 PaymentPayload in PAYMENT-SIGNATURE." };
  }
  const parsed = PaymentPayloadZ.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `Invalid x402 PaymentPayload${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}.` };
  }
  return { ok: true, payment: parsed.data };
}
