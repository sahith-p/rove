// settle() (NI-A3, gate G1). Spec: settlement-xrpl.md §4.
//   from "USD" (default): treasury → merchant cross-currency Payment. Amount = exact XSGD, SendMax = RLUSD cap,
//                         Paths from ripple_path_find, InvoiceID = sha256(paymentId). No tfPartialPayment.
//   from "SGD":           treasury's XSGD float → merchant, same currency (no SendMax/Paths, no swap).
//                         The worker also uses this to return XSGD when a bank payout bounces (id = withdrawalId).
// Success = tesSUCCESS and meta.delivered_amount == local. Idempotent per id: if the treasury already paid this
// InvoiceID to this merchant, the earlier tx is returned instead of paying twice.

import { cmp, money, toMinor, toUnits, type Currency, type Money, type SettleResult } from "@rove/shared";
import type { Path, TransactionMetadata } from "xrpl";
import type { Asset, EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { XrplPathError, XrplTxError } from "./errors";
import { findPaymentByInvoiceId } from "./ledger";
import { findUsdToSgdPath } from "./quote";
import { submitTx, type TxOutcome } from "./submit";
import { buildCrossCurrencyPayment, buildIouPayment, invoiceIdFor } from "./tx";

export interface SettleInput {
  paymentId: string;
  merchantAddress: string;
  local: Money;
  sendMaxUsd: string;
  from?: Currency;
}

/** meta.delivered_amount as SGD Money, checked to be XSGD from our issuer. Throws if missing or another asset. */
export function deliveredSgd(meta: TransactionMetadata, sgd: Asset): Money {
  const d = (meta as unknown as { delivered_amount?: unknown; DeliveredAmount?: unknown }).delivered_amount ??
    (meta as unknown as { DeliveredAmount?: unknown }).DeliveredAmount;
  if (!d || typeof d !== "object") throw new XrplTxError("NO_DELIVERED_AMOUNT", `delivered_amount missing or not a token amount: ${JSON.stringify(d)}`);
  const a = d as { currency?: string; issuer?: string; value?: string };
  if (a.currency !== sgd.currency || a.issuer !== sgd.issuer || !a.value) {
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${JSON.stringify(a)} is not XSGD from ${sgd.issuer}`);
  }
  const v = plainDecimal(a.value);
  // money() is exact: a value with more than 2 decimals can't equal a 2-decimal local amount anyway.
  try {
    return money(v, "SGD");
  } catch {
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${v} XSGD is not a whole number of cents`);
  }
}

function assertPositiveSgd(local: Money): Money {
  if (local.currency !== "SGD") throw new Error(`settle: local must be SGD, got ${local.currency}`);
  const m = money(local.amount, "SGD");
  if (toMinor(m) <= 0n) throw new Error("settle: amount must be positive");
  return m;
}

export function toSettleResult(outcome: TxOutcome, local: Money, sgd: Asset): SettleResult {
  const delivered = deliveredSgd(outcome.meta, sgd);
  if (cmp(delivered, local) !== 0) {
    throw new XrplTxError("DELIVERED_MISMATCH", `delivered ${delivered.amount} XSGD, expected ${local.amount}`, { txHash: outcome.hash });
  }
  return { txHash: outcome.hash, delivered: delivered.amount, ledgerIndex: outcome.ledgerIndex };
}

export async function settle(ctx: EngineContext, input: SettleInput): Promise<SettleResult> {
  const local = assertPositiveSgd(input.local);
  const from = input.from ?? "USD";
  const treasury = ctx.treasuryWallet();
  const sgd = ctx.sgd();
  const invoiceId = invoiceIdFor(input.paymentId);
  const amount = { ...sgd, value: local.amount };
  const dedupe = () => findPaymentByInvoiceId(ctx.conn, { account: treasury.address, destination: input.merchantAddress, invoiceId });

  let tx: object;
  if (from === "SGD") {
    tx = buildIouPayment({ account: treasury.address, destination: input.merchantAddress, amount, invoiceId });
  } else if (from === "USD") {
    const usd = ctx.usd();
    const sendMax = money(input.sendMaxUsd, "USD");
    if (toMinor(sendMax) <= 0n) throw new Error("settle: sendMaxUsd must be positive for a USD settlement");
    let paths: Path[] | undefined;
    const prior = await dedupe(); // cheap pre-check so a replay doesn't fail the SendMax pre-flight below
    if (prior) {
      ctx.log(`settle ${input.paymentId}: already on ledger ${ctx.explorerUrl(prior.hash)}`);
      return toSettleResult(prior, local, sgd);
    }
    try {
      const found = await findUsdToSgdPath(ctx, input.merchantAddress, local);
      if (found) {
        // Pre-flight: if today's pool needs more than SendMax, don't burn a fee on a tecPATH_PARTIAL.
        const need = toUnits(plainDecimal(found.sourceValue), 2, "ceil");
        if (need > toMinor(sendMax)) {
          throw new XrplPathError("tecPATH_PARTIAL", `settle ${input.paymentId}: path needs ${plainDecimal(found.sourceValue)} RLUSD > SendMax ${sendMax.amount}; re-quote`);
        }
        paths = found.paths;
      }
    } catch (err) {
      if (err instanceof XrplPathError) throw err;
      ctx.log(`settle ${input.paymentId}: ripple_path_find failed, using the default path (${err instanceof Error ? err.message : String(err)})`);
    }
    tx = buildCrossCurrencyPayment({
      account: treasury.address,
      destination: input.merchantAddress,
      amount,
      sendMax: { ...usd, value: sendMax.amount },
      invoiceId,
      paths,
    });
  } else {
    throw new Error(`settle: unsupported from currency ${String(from)}`);
  }

  const outcome = await submitTx(ctx, treasury, tx, { label: `settle ${input.paymentId} (${from})`, dedupe });
  return toSettleResult(outcome, local, sgd);
}
