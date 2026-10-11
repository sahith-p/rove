// AUSD lane (Agora's AUSD on Base Sepolia, gasless for the payer). Owner: Nithya · Spec: docs/specs/ausd-lane.md
//
// The payer signs an ERC-3009 TransferWithAuthorization (EIP-712) moving the charge in AUSD to Rove's AUSD_PAY_TO; the web
// verifies it here (signature, amount, balance, unused nonce) and stores it; the worker relayer submits it on-chain and
// pays the gas (apps/worker/src/ausd). The web never signs and never holds a key: everything here is read-only.
//
//   buildAusdCheckout(payment, config)      → CheckoutRes.ausd (what the pay page asks the wallet to sign)
//   expectedAuthorization(payment, from, c) → the exact message a checkout payment must be signed over
//   verifyAusdAuthorization(deps, a, sig)   → shared by POST /api/ausd/authorize and the x402 route
//
// Token facts (verified on Base Sepolia, chainId 84532, with read calls on 2026-10-11; sources in docs/specs/ausd-lane.md):
//   token 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (Agora docs "Contract Deployments" → Testnet), decimals() = 6,
//   name() = "AUSD" but the EIP-712 domain (eip712Domain()) is name "Agora Dollar", version "1" (DOMAIN_SEPARATOR matches),
//   transferWithAuthorization in both the (v, r, s) and the bytes-signature form, authorizationState(address, bytes32).

import type { z } from "zod";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { AusdAuthorization, Db } from "@rove/db";
import { DECIMALS, fromMinor, fromUnits, PaymentStatusRes, toUnits, type CheckoutRes, type Invoice, type Money, type Payment } from "@rove/shared";
import { merchantVerified, respond } from "../shops/_shared";
import type { WebDeps } from "./deps";
import { HttpError } from "./http";

/** Agora AUSD on Base Sepolia, as read from the chain (see the header). */
export const AUSD_BASE_SEPOLIA = {
  chainId: 84532,
  network: "eip155:84532", // CAIP-2, as x402 v2 names it
  token: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  decimals: 6,
  eip712Name: "Agora Dollar",
  eip712Version: "1",
} as const;

/** EIP-3009 typed data (the same struct x402's `exact` EVM scheme signs). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** A checkout authorization stays valid this long after the quote expires: time to open a wallet and sign. */
export const AUSD_VALIDITY_AFTER_QUOTE_SEC = 10 * 60;
/** The relayer needs some time left on an authorization to get it mined. */
export const AUSD_MIN_REMAINING_SEC = 30;

const AUSD_READ_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface AusdConfig {
  chainId: number;
  network: string;
  rpcUrl: string;
  token: Address;
  decimals: number;
  /** Rove's AUSD receive address (public). */
  payTo: Address;
  eip712Name: string;
  eip712Version: string;
}

export interface TransferWithAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Read-only chain access the web needs. */
export interface AusdChainReader {
  balanceOf(account: Address): Promise<bigint>;
  authorizationState(authorizer: Address, nonce: Hex): Promise<boolean>;
}

export interface AusdDeps {
  config: AusdConfig;
  chain: AusdChainReader;
}

type Env = Record<string, string | undefined>;

/** Pure. Null when AUSD_PAY_TO isn't set (the lane is off: checkout answers 503 ausd_not_configured). */
export function ausdConfigFromEnv(env: Env = process.env): AusdConfig | null {
  const payTo = env.AUSD_PAY_TO?.trim();
  if (!payTo || !isAddress(payTo)) return null;
  const token = env.AUSD_TOKEN_ADDRESS?.trim() || AUSD_BASE_SEPOLIA.token;
  if (!isAddress(token)) throw new Error(`AUSD_TOKEN_ADDRESS is not an address: ${token}`);
  const decimals = env.AUSD_DECIMALS ? Number.parseInt(env.AUSD_DECIMALS, 10) : AUSD_BASE_SEPOLIA.decimals;
  if (!Number.isInteger(decimals) || decimals < DECIMALS.USD || decimals > 36) throw new Error(`AUSD_DECIMALS is invalid: ${env.AUSD_DECIMALS}`);
  return {
    chainId: AUSD_BASE_SEPOLIA.chainId,
    network: AUSD_BASE_SEPOLIA.network,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org",
    token: getAddress(token),
    decimals,
    payTo: getAddress(payTo),
    eip712Name: AUSD_BASE_SEPOLIA.eip712Name,
    eip712Version: AUSD_BASE_SEPOLIA.eip712Version,
  };
}

export function createAusdChainReader(config: Pick<AusdConfig, "rpcUrl" | "token">): AusdChainReader {
  const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl, { timeout: 8_000 }) });
  return {
    balanceOf: (account) => client.readContract({ address: config.token, abi: AUSD_READ_ABI, functionName: "balanceOf", args: [account] }),
    authorizationState: (authorizer, nonce) =>
      client.readContract({ address: config.token, abi: AUSD_READ_ABI, functionName: "authorizationState", args: [authorizer, nonce] }),
  };
}

// Memoized per server process like getWebDeps (globalThis survives Next dev's module reloads).
const KEY = Symbol.for("rove.ausdDeps");
type Holder = { [KEY]?: AusdDeps | null };

/** The lane's config + chain reader. 503 ausd_not_configured when AUSD_PAY_TO isn't set. */
export function getAusdDeps(): AusdDeps {
  const g = globalThis as Holder;
  if (g[KEY] === undefined) {
    const config = ausdConfigFromEnv();
    g[KEY] = config ? { config, chain: createAusdChainReader(config) } : null;
  }
  const deps = g[KEY];
  if (!deps) throw new HttpError(503, "ausd_not_configured", "Paying with AUSD isn't set up yet. Please pay by card.");
  return deps;
}

/** Tests: inject config + a fake chain. null resets to env on the next getAusdDeps(). */
export function setAusdDepsForTests(deps: AusdDeps | null): void {
  const g = globalThis as Holder;
  if (deps) g[KEY] = deps;
  else delete g[KEY];
}

// ------------------------------------------------------------------ building

/** Deterministic per payment: retries sign the same authorization, and the nonce maps back to the payment. */
export function ausdNonce(paymentId: string): Hex {
  return keccak256(stringToHex(paymentId));
}

export function ausdDomain(config: AusdConfig) {
  return { name: config.eip712Name, version: config.eip712Version, chainId: config.chainId, verifyingContract: config.token } as const;
}

/** A USD amount in AUSD base units (exact; AUSD has more decimals than cents). */
export function usdToAusdUnits(usd: Money, decimals: number): bigint {
  if (usd.currency !== "USD") throw new Error(`AUSD is a dollar: can't charge ${usd.currency}`);
  return toUnits(usd.amount, decimals, "exact");
}

/** What an AUSD payer is charged: the quote's USD, rounded up to the cent (never undercharge). */
export function ausdCharge(quote: { usd: Money }): Money {
  return fromMinor(toUnits(quote.usd.amount, DECIMALS.USD, "ceil"), "USD");
}

type AusdCheckout = NonNullable<z.infer<typeof CheckoutRes>["ausd"]>;
type ChargedPayment = Pick<Payment, "id" | "quote" | "charge">;

function chargeOf(payment: ChargedPayment): Money {
  const charge = payment.charge ?? payment.quote?.usd;
  if (!charge) throw new Error(`payment ${payment.id} has no charge or quote`);
  return charge;
}

/** validBefore for a checkout payment: quote expiry + 10 minutes, in unix seconds. */
export function checkoutValidBefore(payment: Pick<Payment, "id" | "quote">): bigint {
  if (!payment.quote) throw new Error(`payment ${payment.id} has no quote`);
  return BigInt(Math.floor(Date.parse(payment.quote.expiresAt) / 1000) + AUSD_VALIDITY_AFTER_QUOTE_SEC);
}

/** CheckoutRes.ausd for a `created` ausd payment. Amount = the USD charge; value = the same in AUSD base units. */
export function buildAusdCheckout(payment: ChargedPayment, config: AusdConfig): AusdCheckout {
  const charge = chargeOf(payment);
  return {
    chainId: config.chainId,
    token: config.token,
    decimals: config.decimals,
    amount: charge.amount,
    authorization: {
      to: config.payTo,
      value: usdToAusdUnits(charge, config.decimals).toString(),
      validAfter: "0",
      validBefore: checkoutValidBefore(payment).toString(),
      nonce: ausdNonce(payment.id),
    },
    domain: ausdDomain(config),
  };
}

/** The exact message a checkout payment must be signed over, with the payer's address as `from`. */
export function expectedAuthorization(payment: ChargedPayment, from: Address, config: AusdConfig): TransferWithAuthorization {
  const built = buildAusdCheckout(payment, config).authorization;
  return {
    from: getAddress(from),
    to: getAddress(built.to),
    value: BigInt(built.value),
    validAfter: BigInt(built.validAfter),
    validBefore: BigInt(built.validBefore),
    nonce: built.nonce as Hex,
  };
}

export function toStoredAuthorization(a: TransferWithAuthorization, signature: Hex): AusdAuthorization {
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: a.value.toString(),
    validAfter: a.validAfter.toString(),
    validBefore: a.validBefore.toString(),
    nonce: a.nonce.toLowerCase(),
    signature: signature.toLowerCase(),
  };
}

// ------------------------------------------------------------------ verifying

export type AusdRejection =
  | "invalid_signature"
  | "authorization_not_yet_valid"
  | "authorization_expired"
  | "authorization_used"
  | "insufficient_funds"
  | "chain_unavailable";

export type AusdVerdict = { ok: true } | { ok: false; reason: AusdRejection; message: string };

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/** EIP-712 signature by `a.from` over `a` on this token's domain, in a form the contract accepts (65 bytes, low s). */
export async function isValidAusdSignature(config: AusdConfig, a: TransferWithAuthorization, signature: string): Promise<boolean> {
  if (!SIGNATURE_RE.test(signature)) return false;
  try {
    const { s } = parseSignature(signature as Hex);
    if (BigInt(s) > SECP256K1_N_HALF) return false; // the token's ECDSA check rejects high-s signatures
    return await verifyTypedData({
      address: a.from,
      domain: ausdDomain(config),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: a,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

/**
 * Everything short of submitting it: signature, validity window (with time left to relay), unused nonce, balance.
 * Read-only RPC; the caller has already checked `to` and `value` against what it expects.
 */
export async function verifyAusdAuthorization(
  deps: AusdDeps,
  a: TransferWithAuthorization,
  signature: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<AusdVerdict> {
  if (!(await isValidAusdSignature(deps.config, a, signature))) {
    return { ok: false, reason: "invalid_signature", message: "The signature doesn't match this payment (payer, amount or recipient)." };
  }
  if (a.validAfter > BigInt(nowSec)) return { ok: false, reason: "authorization_not_yet_valid", message: "This authorization isn't valid yet." };
  if (a.validBefore < BigInt(nowSec + AUSD_MIN_REMAINING_SEC)) {
    return { ok: false, reason: "authorization_expired", message: "This authorization has expired. Start the payment again." };
  }
  let used: boolean;
  let balance: bigint;
  try {
    [used, balance] = await Promise.all([deps.chain.authorizationState(a.from, a.nonce), deps.chain.balanceOf(a.from)]);
  } catch (err) {
    console.warn("[api] ausd: Base Sepolia read failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "chain_unavailable", message: "Couldn't reach Base Sepolia to check the payment. Please try again." };
  }
  if (used) return { ok: false, reason: "authorization_used", message: "This authorization was already used or cancelled." };
  if (balance < a.value) {
    return {
      ok: false,
      reason: "insufficient_funds",
      message: `This wallet holds ${fromUnits(balance, deps.config.decimals)} AUSD; the payment needs ${fromUnits(a.value, deps.config.decimals)}.`,
    };
  }
  return { ok: true };
}

/** HTTP status for a rejection on POST /api/ausd/authorize. */
export function rejectionStatus(reason: AusdRejection): number {
  switch (reason) {
    case "invalid_signature":
      return 400;
    case "authorization_used":
      return 409;
    case "authorization_expired":
      return 410;
    case "chain_unavailable":
      return 503;
    default:
      return 422;
  }
}

/** Payment statuses that mean the money for an invoice already arrived (or is arriving). */
const PAID_STATUSES: ReadonlySet<Payment["status"]> = new Set(["authorized", "settling", "settled", "partially_refunded", "refunded"]);

/**
 * The invoice is paid, or another payment for it got past `created` (a card authorized but not settled yet leaves the
 * invoice `open`). Checked before an AUSD authorization is accepted, so AUSD doesn't move for an invoice that's done.
 */
export async function invoicePaidElsewhere(
  db: Pick<Db, "getInvoice" | "listPayments">,
  invoice: Pick<Invoice, "id" | "merchantId" | "status" | "paymentId">,
  exceptPaymentId?: string,
): Promise<boolean> {
  if (invoice.status === "paid" && invoice.paymentId !== exceptPaymentId) return true;
  const payments = await db.listPayments(invoice.merchantId, 50);
  return payments.some((p) => p.invoiceId === invoice.id && p.id !== exceptPaymentId && PAID_STATUSES.has(p.status));
}

// ------------------------------------------------------------------ responses

export function basescanTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

/** PaymentStatusRes for an ausd payment (what GET /api/payments/:id shows, minus the merchant-only payer name). */
export async function paymentStatusResponse(deps: Pick<WebDeps, "db" | "settlement">, payment: Payment, init?: ResponseInit): Promise<Response> {
  const merchant = await deps.db.getMerchant(payment.merchantId);
  if (!merchant) throw new Error(`payment ${payment.id} has no merchant ${payment.merchantId}`);
  return respond(
    PaymentStatusRes,
    {
      paymentId: payment.id,
      status: payment.status,
      local: payment.local,
      ...(payment.charge ? { charge: payment.charge } : {}),
      merchantName: merchant.name,
      createdAt: payment.createdAt,
      refunded: payment.refunded,
      merchantVerified: await merchantVerified(deps, merchant),
      lines: payment.lines,
      method: payment.method,
      ...(payment.settleTxHash ? { settleTxHash: payment.settleTxHash, explorerUrl: deps.settlement.explorerUrl(payment.settleTxHash) } : {}),
    },
    init,
  );
}
