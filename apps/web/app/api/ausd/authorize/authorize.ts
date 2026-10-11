// POST /api/ausd/authorize: the payer's signed ERC-3009 authorization for an `ausd` checkout. Owner: Nithya
// Spec: docs/specs/ausd-lane.md. AusdAuthorizeReq → PaymentStatusRes.
//
// The client sends only { paymentId, from, signature }. Everything signed over (to, value, validAfter, validBefore, nonce)
// is rebuilt from the DB, so a signature over another amount or recipient simply doesn't verify. Then: unused nonce and
// enough AUSD (read-only RPC), store it once, answer. The worker relayer polls for stored authorizations; nothing to nudge.
//
// Errors: 400 invalid_address / invalid_signature_format / invalid_signature · 404 payment_not_found ·
// 409 wrong_method / payment_not_open / already_authorized / authorization_used / authorization_reused / invoice_paid /
// invoice_cancelled · 410 quote_expired / authorization_expired · 422 insufficient_funds · 503 chain_unavailable.

import type { z } from "zod";
import { getAddress, isAddress, type Hex } from "viem";
import type { AusdAuthorizeReq } from "@rove/shared";
import {
  AUSD_MIN_REMAINING_SEC,
  expectedAuthorization,
  invoicePaidElsewhere,
  paymentStatusResponse,
  rejectionStatus,
  toStoredAuthorization,
  verifyAusdAuthorization,
  type AusdDeps,
} from "../../_lib/ausd";
import type { WebDeps } from "../../_lib/deps";
import { HttpError } from "../../_lib/http";

export type AusdAuthorizeBody = z.infer<typeof AusdAuthorizeReq>;

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export async function authorizeAusd(deps: WebDeps, ausd: AusdDeps, body: AusdAuthorizeBody, nowMs = Date.now()): Promise<Response> {
  const fromRaw = body.from.trim();
  const signature = body.signature.trim();
  if (!isAddress(fromRaw)) throw new HttpError(400, "invalid_address", "That isn't a valid wallet address.");
  if (!SIGNATURE_RE.test(signature)) throw new HttpError(400, "invalid_signature_format", "The signature must be 65 bytes of hex.");
  const from = getAddress(fromRaw);

  const payment = await deps.db.getPayment(body.paymentId.trim());
  if (!payment) throw new HttpError(404, "payment_not_found", "We couldn't find this payment.");
  if (payment.method !== "ausd") throw new HttpError(409, "wrong_method", "This payment isn't an AUSD payment.");

  // A retry of what we already stored is fine at any status (the page may resend after a network blip).
  const stored = await deps.db.getAusdRelay(payment.id);
  if (stored) {
    const same = stored.authorization.from.toLowerCase() === from.toLowerCase() && stored.authorization.signature.toLowerCase() === signature.toLowerCase();
    if (same) return paymentStatusResponse(deps, payment);
    throw new HttpError(409, "already_authorized", "This payment already has a signed authorization.");
  }
  if (payment.status !== "created") throw new HttpError(409, "payment_not_open", "This payment can't be paid any more.");

  if (payment.invoiceId) {
    const invoice = await deps.db.getInvoice(payment.invoiceId);
    if (invoice?.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "The shop cancelled this request.");
    if (invoice && (await invoicePaidElsewhere(deps.db, invoice, payment.id))) throw new HttpError(409, "invoice_paid", "This has already been paid.");
  }

  const expected = expectedAuthorization(payment, from, ausd.config);
  const nowSec = Math.floor(nowMs / 1000);
  if (expected.validBefore < BigInt(nowSec + AUSD_MIN_REMAINING_SEC)) {
    throw new HttpError(410, "quote_expired", "This checkout expired. Please start the payment again.");
  }

  const verdict = await verifyAusdAuthorization(ausd, expected, signature, nowSec);
  if (!verdict.ok) throw new HttpError(rejectionStatus(verdict.reason), verdict.reason, verdict.message);

  const result = await deps.db.setAusdAuthorization(payment.id, toStoredAuthorization(expected, signature as Hex));
  if (result.ok) return paymentStatusResponse(deps, result.payment);
  switch (result.reason) {
    case "different_authorization":
      throw new HttpError(409, "already_authorized", "This payment already has a signed authorization.");
    case "authorization_reused":
      throw new HttpError(409, "authorization_reused", "This authorization already paid for something else.");
    case "not_found":
      throw new HttpError(404, "payment_not_found", "We couldn't find this payment.");
    case "not_ausd":
      throw new HttpError(409, "wrong_method", "This payment isn't an AUSD payment.");
    case "not_created":
      throw new HttpError(409, "payment_not_open", "This payment can't be paid any more.");
  }
}
