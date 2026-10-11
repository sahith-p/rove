// The paying half of x402 v2 for the `exact` EVM scheme (EIP-3009), as a minimal agent would run it: read the 402, sign a
// TransferWithAuthorization with a local key, retry with PAYMENT-SIGNATURE. No gas, no RPC: the server relays.
// Used by scripts/x402-agent-pay.ts and the x402 tests. Owner: Nithya · Spec: docs/specs/ausd-lane.md §x402.

import { getAddress, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { decodeHeader, encodeHeader, PaymentRequiredZ, X402_HEADERS, X402_VERSION, type PaymentPayload, type PaymentRequired, type SettlementResponse } from "./protocol";

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The 402's requirements, from the PAYMENT-REQUIRED header (v2), else the JSON body. */
export async function readPaymentRequired(res: Response): Promise<PaymentRequired> {
  const header = res.headers.get(X402_HEADERS.required);
  const raw = header ? decodeHeader(header) : await res.json();
  return PaymentRequiredZ.parse(raw);
}

export interface BuildOptions {
  nowSec?: number;
  /** Default: 32 random bytes (x402 clients pick their own nonce). */
  nonce?: Hex;
  /** Which network to pay on (default Base Sepolia). */
  network?: string;
}

/** Sign an EIP-3009 authorization for the first `exact` requirement on `network` and wrap it as a v2 PaymentPayload. */
export async function buildPaymentPayload(account: PrivateKeyAccount, required: PaymentRequired, opts: BuildOptions = {}): Promise<PaymentPayload> {
  const network = opts.network ?? "eip155:84532";
  const accepted = required.accepts.find((r) => r.scheme === "exact" && r.network === network);
  if (!accepted) throw new Error(`no "exact" payment option on ${network}`);
  const name = accepted.extra?.name;
  const version = accepted.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") throw new Error("requirements lack the token's EIP-712 name/version (extra)");
  const chainId = Number(network.split(":")[1]);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(accepted.payTo),
    value: accepted.amount,
    validAfter: String(nowSec - 600), // reference-client convention: tolerate clock skew
    validBefore: String(nowSec + accepted.maxTimeoutSeconds),
    nonce: opts.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: { name, version, chainId, verifyingContract: getAddress(accepted.asset) },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { x402Version: X402_VERSION, resource: required.resource, accepted, payload: { signature, authorization } };
}

export interface PayResult {
  status: number;
  body: unknown;
  paymentResponse: SettlementResponse | null;
  required: PaymentRequired;
}

/** GET url → 402 → sign → retry with PAYMENT-SIGNATURE (resending while the server answers 202). */
export async function payX402(
  url: string,
  account: PrivateKeyAccount,
  opts: { fetch?: typeof fetch; maxPolls?: number; pollMs?: number; log?: (msg: string) => void } = {},
): Promise<PayResult> {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const first = await doFetch(url);
  if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}: ${await first.text()}`);
  const required = await readPaymentRequired(first);
  log(`402: ${required.resource.description ?? required.resource.url} → ${required.accepts.map((a) => `${a.amount} of ${a.asset} on ${a.network}`).join(", ")}`);

  const header = encodeHeader(await buildPaymentPayload(account, required));
  for (let i = 0; ; i++) {
    const res = await doFetch(url, { headers: { [X402_HEADERS.signature]: header } });
    const body = await res.json().catch(() => null);
    const pr = res.headers.get(X402_HEADERS.response);
    const paymentResponse = pr ? (decodeHeader(pr) as SettlementResponse) : null;
    if (res.status !== 202 || i >= (opts.maxPolls ?? 20)) return { status: res.status, body, paymentResponse, required };
    log("202: relaying on Base Sepolia, resending the same payment to poll…");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
  }
}
