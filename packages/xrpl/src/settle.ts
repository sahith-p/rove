// settle() (NI-A3 gate G1; any corridor). Spec: settlement-xrpl.md §4, corridors.md §2.
//   from == local currency: the treasury's float of that stablecoin → merchant, same currency (no SendMax/Paths, no
//                           swap). E.g. SGD → SGD. The worker also uses this to return funds when a bank payout bounces
//                           (id = withdrawalId).
//   from != local currency: ONE treasury → merchant cross-currency Payment. Amount = exact local, SendMax = the payer
//                           currency cap (sendMax, or sendMaxUsd for USD), Paths from ripple_path_find (fallback: the
//                           RLUSD hub path for a 2-hop pair like EUR → RLUSD → XSGD). InvoiceID = sha256(paymentId).
//                           No tfPartialPayment.
// Success = tesSUCCESS and meta.delivered_amount == local. Idempotent per id: if the treasury already paid this
// InvoiceID to this merchant, the earlier tx is returned instead of paying twice.

import { cmp, DECIMALS, isCurrency, money, toMinor, toUnits, type Currency, type Money, type SettleResult } from "@rove/shared";
import type { Path, TransactionMetadata } from "xrpl";
import type { Asset, EngineContext } from "./context";
import { currencyFromHex, plainDecimal } from "./currency";
import { XrplPathError, XrplTxError } from "./errors";
import { findPaymentByInvoiceId } from "./ledger";
import { findRoute, routeFor } from "./quote";
import { submitTx, type TxOutcome } from "./submit";
import { buildCrossCurrencyPayment, buildIouPayment, hubPaths, invoiceIdFor } from "./tx";

export interface SettleInput {
  paymentId: string;
  merchantAddress: string;
  local: Money;
  sendMaxUsd: string;
  from?: Currency;
  /** SendMax in the `from` currency (quote.sendMax). Required for a cross-currency settle from anything but USD. */
  sendMax?: string;
}

/** meta.delivered_amount as Money in `currency`, checked to be `asset` (code + issuer). Throws if missing or another asset. */
export function deliveredMoney(meta: TransactionMetadata, asset: Asset, currency: Currency): Money {
  const d = (meta as unknown as { delivered_amount?: unknown; DeliveredAmount?: unknown }).delivered_amount ??
    (meta as unknown as { DeliveredAmount?: unknown }).DeliveredAmount;
  if (!d || typeof d !== "object") throw new XrplTxError("NO_DELIVERED_AMOUNT", `delivered_amount missing or not a token amount: ${JSON.stringify(d)}`);
  const a = d as { currency?: string; issuer?: string; value?: string };
  const code = currencyFromHex(asset.currency);
  if (a.currency !== asset.currency || a.issuer !== asset.issuer || !a.value) {
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${JSON.stringify(a)} is not ${code} from ${asset.issuer}`);
  }
  const v = plainDecimal(a.value);
  // money() is exact: a value with more decimals than the currency has can't equal a local amount anyway.
  try {
    return money(v, currency);
  } catch {
    const unit = DECIMALS[currency] === 2 ? "cents" : `${currency} minor units`;
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${v} ${code} is not a whole number of ${unit}`);
  }
}

/** meta.delivered_amount as SGD Money, checked to be XSGD from our issuer. Throws if missing or another asset. */
export function deliveredSgd(meta: TransactionMetadata, sgd: Asset): Money {
  return deliveredMoney(meta, sgd, "SGD");
}

/** `local` normalised; must be a positive amount in an enabled currency. */
export function assertPositive(local: Money): Money {
  if (!isCurrency(local.currency)) throw new Error(`settle: unsupported local currency ${String(local.currency)}`);
  const m = money(local.amount, local.currency);
  if (toMinor(m) <= 0n) throw new Error("settle: amount must be positive");
  return m;
}

/** As assertPositive, but only SGD (the original corridor). */
export function assertPositiveSgd(local: Money): Money {
  if (local.currency !== "SGD") throw new Error(`settle: local must be SGD, got ${local.currency}`);
  return assertPositive(local);
}

/** Success only when exactly `local` of `asset` was delivered. */
export function toSettleResult(outcome: TxOutcome, local: Money, asset: Asset): SettleResult {
  const delivered = deliveredMoney(outcome.meta, asset, local.currency);
  if (cmp(delivered, local) !== 0) {
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${delivered.amount} ${currencyFromHex(asset.currency)}, expected ${local.amount}`, {
      txHash: outcome.hash,
    });
  }
  return { txHash: outcome.hash, delivered: delivered.amount, ledgerIndex: outcome.ledgerIndex };
}

/** The SendMax for a cross-currency settle, in `from`. USD falls back to sendMaxUsd (original contract). */
export function sendMaxFor(input: Pick<SettleInput, "sendMax" | "sendMaxUsd">, from: Currency, to: Currency): Money {
  const raw = input.sendMax ?? (from === "USD" ? input.sendMaxUsd : undefined);
  if (!raw) {
    throw new Error(`settle: sendMax (quote.sendMax, in ${from}) is required for a ${from} → ${to} settlement`);
  }
  const m = money(raw, from);
  if (toMinor(m) <= 0n) throw new Error(`settle: ${input.sendMax ? "sendMax" : "sendMaxUsd"} must be positive for a ${from} settlement`);
  return m;
}

export async function settle(ctx: EngineContext, input: SettleInput): Promise<SettleResult> {
  const local = assertPositive(input.local);
  const from = input.from ?? "USD";
  if (!isCurrency(from)) throw new Error(`settle: unsupported from currency ${String(from)}`);
  const treasury = ctx.treasuryWallet();
  const dest = ctx.asset(local.currency);
  const invoiceId = invoiceIdFor(input.paymentId);
  const amount = { ...dest, value: local.amount };
  const dedupe = () => findPaymentByInvoiceId(ctx.conn, { account: treasury.address, destination: input.merchantAddress, invoiceId });

  let tx: object;
  if (from === local.currency) {
    tx = buildIouPayment({ account: treasury.address, destination: input.merchantAddress, amount, invoiceId });
  } else {
    const src = ctx.asset(from);
    const sendMax = sendMaxFor(input, from, local.currency);
    let paths: Path[] | undefined;
    const prior = await dedupe(); // cheap pre-check so a replay doesn't fail the SendMax pre-flight below
    if (prior) {
      ctx.log(`settle ${input.paymentId}: already on ledger ${ctx.explorerUrl(prior.hash)}`);
      return toSettleResult(prior, local, dest);
    }
    try {
      const found = await findRoute(ctx, input.merchantAddress, local, from);
      if (found) {
        // Pre-flight: if today's pools need more than SendMax, don't burn a fee on a tecPATH_PARTIAL.
        const need = toUnits(plainDecimal(found.sourceValue), DECIMALS[from], "ceil");
        if (need > toMinor(sendMax)) {
          throw new XrplPathError(
            "tecPATH_PARTIAL",
            `settle ${input.paymentId}: path needs ${plainDecimal(found.sourceValue)} ${ctx.tokenName(from)} > SendMax ${sendMax.amount}; re-quote`,
          );
        }
        paths = found.paths;
      }
    } catch (err) {
      if (err instanceof XrplPathError) throw err;
      ctx.log(`settle ${input.paymentId}: ripple_path_find failed, using the default path (${err instanceof Error ? err.message : String(err)})`);
    }
    // No path from path_find: a single hop (USD ↔ X) rides the default path; two hops need the explicit hub path.
    if (!paths?.length && routeFor(from, local.currency).length === 3) paths = hubPaths(ctx.usd(), dest);
    tx = buildCrossCurrencyPayment({
      account: treasury.address,
      destination: input.merchantAddress,
      amount,
      sendMax: { ...src, value: sendMax.amount },
      invoiceId,
      paths,
    });
  }

  const label = local.currency === "SGD" ? `settle ${input.paymentId} (${from})` : `settle ${input.paymentId} (${from} → ${local.currency})`;
  const outcome = await submitTx(ctx, treasury, tx, { label, dedupe });
  return toSettleResult(outcome, local, dest);
}
