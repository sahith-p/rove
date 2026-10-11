// method=bnb branch of POST /api/checkout. Owner: Nithya · Task: NI-C6 · Spec: docs/specs/bnb-lane.md,
// payments-stripe.md §1 step 7. The target is already resolved and validated by checkout.ts.
//
//   quote = settlement.quote({ local }); charge = quote.usd (USDT is a dollar: a BNB payer is always a USD payer)
//   index = db.nextDepositIndex() → depositAddressAt(BSC_DEPOSIT_XPUB, index)   (../_lib/bsc.ts; no secrets on the web)
//   db.insertPayment({ ..., method: "bnb", charge, bnbDepositAddress })
//   → { paymentId, local, quote, charge, bnb: { chainId: 97, depositAddress, token, decimals, amount: charge.amount } }
// The page then sends `token.transfer(depositAddress, parseUnits(amount, decimals))` on BSC testnet (Privy / MetaMask);
// the worker's watcher (apps/worker/src/bnb) authorizes the payment after 3 confirmations.
//
// Reuse, same rules as the card lane: the page calls checkout again on reload and on Pay, so an unexpired `created`
// bnb payment for the same target is handed back with the SAME deposit address (a payer who already sent USDT must
// never be shown a second address). `Payment` doesn't carry bnb_deposit_address, so a bnb payment id ends in
// `_bsc<index>`: reuse re-derives the address from the index and confirms it with getPaymentByDepositAddress.

import type { z } from "zod";
import type { Db } from "@rove/db";
import { cmp, DECIMALS, fromMinor, newId, toMinor, toUnits, type CheckoutRes, type InvoiceLine, type Money, type Payment, type Quote } from "@rove/shared";
import { BSC_TESTNET_CHAIN_ID, bscConfigFromEnv, depositAddressAt, type BscWebConfig } from "../_lib/bsc";
import type { WebDeps } from "../_lib/deps";
import { HttpError } from "../_lib/http";
import type { CheckoutTarget } from "./target";

type CheckoutResult = z.infer<typeof CheckoutRes>;

/** A reused quote must have at least this long left (same as the card lane's REUSE_MIN_REMAINING_MS). */
export const BNB_REUSE_MIN_REMAINING_MS = 5_000;
/** How many of the merchant's most recent payments to scan for a reusable one. */
const REUSE_SCAN = 50;
const PAID: ReadonlySet<Payment["status"]> = new Set(["authorized", "settling", "settled", "partially_refunded", "refunded"]);

export async function checkoutBnb(deps: WebDeps, target: CheckoutTarget, now = Date.now()): Promise<CheckoutResult> {
  const cfg = bscConfigFromEnv();
  if (!cfg) throw new HttpError(503, "bnb_not_configured", "Paying from a crypto wallet isn't set up yet. Please pay by card.");

  const reused = await reuseCreated(deps.db, cfg, target, now);
  if (reused) return reused;

  const quote = await deps.settlement.quote({ local: target.local });
  // Quotes are in cents already; never ask for less if an engine ever returns more precision.
  const charge = fromMinor(toUnits(quote.usd.amount, DECIMALS.USD, "ceil"), "USD");
  const index = await deps.db.nextDepositIndex();
  const depositAddress = depositAddressAt(cfg.xpub, index);
  const paymentId = bnbPaymentId(index);

  await deps.db.insertPayment({
    id: paymentId,
    merchantId: target.merchantId,
    source: target.source,
    invoiceId: target.invoiceId,
    lines: target.lines,
    local: target.local,
    quote,
    charge,
    method: "bnb",
    payer: target.payer,
    bnbDepositAddress: depositAddress,
  });
  return response(paymentId, target.local, quote, charge, depositAddress, cfg);
}

/** `pay_<hex>_bsc<index>`: the deposit index travels in the id so reuse can re-derive the address. */
export function bnbPaymentId(index: number): string {
  return `${newId("pay")}_bsc${index}`;
}

export function depositIndexOf(paymentId: string): number | null {
  const m = /_bsc(\d{1,10})$/.exec(paymentId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

function response(paymentId: string, local: Money, quote: Quote, charge: Money, depositAddress: string, cfg: BscWebConfig): CheckoutResult {
  return {
    paymentId,
    local,
    quote,
    charge,
    bnb: { chainId: BSC_TESTNET_CHAIN_ID, depositAddress, token: cfg.token, decimals: cfg.decimals, amount: charge.amount },
  };
}

/**
 * The newest unexpired `created` bnb payment for the same target, with its address → hand it back.
 * An invoice that a payment already got past `created` → 409 instead of a new deposit address.
 */
async function reuseCreated(db: Db, cfg: BscWebConfig, target: CheckoutTarget, now: number): Promise<CheckoutResult | null> {
  const same = (await db.listPayments(target.merchantId, REUSE_SCAN)).filter((p) => sameTarget(p, target)); // newest first
  if (target.invoiceId && same.some((p) => PAID.has(p.status))) throw new HttpError(409, "invoice_paid", "This has already been paid.");

  for (const p of same) {
    if (p.status !== "created" || p.method !== "bnb" || p.charge?.currency !== "USD" || !p.quote) continue;
    if (Date.parse(p.quote.expiresAt) - now < BNB_REUSE_MIN_REMAINING_MS) continue;
    const index = depositIndexOf(p.id);
    if (index === null) continue;
    const depositAddress = depositAddressAt(cfg.xpub, index);
    // Guards against a rotated xpub: only hand out an address the DB says belongs to this payment.
    const owner = await db.getPaymentByDepositAddress(depositAddress);
    if (owner?.id !== p.id) continue;
    return response(p.id, p.local, p.quote, p.charge, depositAddress, cfg);
  }
  return null;
}

// Same target identity as the card lane (checkout.ts): invoice id, or fixed-QR basket + amount + payer phone.
function sameTarget(p: Payment, t: CheckoutTarget): boolean {
  if (t.invoiceId) return p.invoiceId === t.invoiceId;
  return (
    p.source === "fixed_qr" &&
    p.invoiceId === null &&
    p.local.currency === t.local.currency &&
    cmp(p.local, t.local) === 0 &&
    linesKey(p.lines) === linesKey(t.lines) &&
    (p.payer?.phone ?? null) === (t.payer?.phone ?? null)
  );
}

function linesKey(lines: InvoiceLine[]): string {
  return JSON.stringify(
    lines.map((l) => [l.menuItemId ?? "", l.name, l.qty, l.unit.currency, toMinor(l.unit).toString()].join("|")).sort(),
  );
}
