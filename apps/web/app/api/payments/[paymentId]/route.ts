// GET /api/payments/:paymentId → PaymentStatusRes
// Owner: Nithya · Task: NI-B4 · Spec: docs/specs/payments-stripe.md §4 · Schemas: @rove/shared api.ts
// Public (no auth): payment ids are unguessable. Polled by /pay (after paying) and rendered by the receipt /r/<id>.
// The payer's phone is never sent. payerName (the merchant's own contact name for the payer) is added only for the
// merchant's sale view: a valid `sale` session whose ref is this payment and whose merchant owns it.

import { PaymentStatusRes, type Payment } from "@rove/shared";
import { getWebDeps, type WebDeps } from "../../_lib/deps";
import { HttpError, route } from "../../_lib/http";
import { optionalSession } from "../../_lib/session";
import { merchantVerified, respond } from "../../shops/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ paymentId: string }> };

const NOT_FOUND = () => new HttpError(404, "payment_not_found", "We couldn't find this payment.");

const digits = (s: string) => s.replace(/\D/g, "");
/** Auto-added contacts are named after their phone number; that must not leak as a "name". */
const PHONE_LIKE = /^[+\d\s().-]*$/;

async function payerNameFor(deps: Pick<WebDeps, "db">, payment: Payment): Promise<string | undefined> {
  if (!payment.payer) return undefined;
  const want = digits(payment.payer.phone);
  if (!want) return undefined;
  const contacts = await deps.db.findContacts(payment.merchantId);
  const name = contacts.find((c) => digits(c.phone) === want)?.name.trim();
  return name && !PHONE_LIKE.test(name) ? name : undefined;
}

export const GET = route<Ctx>(async (req, { params }) => {
  const { paymentId: raw } = await params;
  const paymentId = raw.trim();
  if (!paymentId || paymentId.length > 64) throw NOT_FOUND();

  const deps = getWebDeps();
  const payment = await deps.db.getPayment(paymentId);
  if (!payment) throw NOT_FOUND();
  const merchant = await deps.db.getMerchant(payment.merchantId);
  if (!merchant) throw NOT_FOUND();

  // The owning merchant sees the payer's name: a `sale` session for this payment, or their `shop` session (/shop links
  // its receipts with it).
  const session = optionalSession(req, ["sale", "shop"]);
  const merchantSale =
    session !== null && session.merchantId === payment.merchantId && (session.scope === "shop" || session.ref === payment.id);

  const [merchantVerifiedFlag, payerName] = await Promise.all([
    merchantVerified(deps, merchant),
    merchantSale ? payerNameFor(deps, payment) : Promise.resolve(undefined),
  ]);

  return respond(PaymentStatusRes, {
    paymentId: payment.id,
    status: payment.status,
    local: payment.local,
    ...(payment.charge ? { charge: payment.charge } : {}),
    merchantName: merchant.name,
    createdAt: payment.createdAt,
    refunded: payment.refunded,
    ...(payerName ? { payerName } : {}),
    merchantVerified: merchantVerifiedFlag,
    lines: payment.lines,
    method: payment.method,
    ...(payment.settleTxHash ? { settleTxHash: payment.settleTxHash, explorerUrl: deps.settlement.explorerUrl(payment.settleTxHash) } : {}),
  });
});
