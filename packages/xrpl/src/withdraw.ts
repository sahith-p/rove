// Withdrawals, the on-chain half (NI-A5). Spec: settlement-xrpl.md §7, withdrawals.md §3c.
//   sweepToRedemption: merchant → REDEMPTION (StraitsX in production), XSGD, InvoiceID = sha256(withdrawalId).
//   sendToWallet:      merchant → the merchant's own XRPL wallet, XSGD, after checking the wallet can receive it.
// Both are idempotent per withdrawal id: a retried /execute finds the earlier tx by InvoiceID instead of paying twice.

import { add, cmp, fromMinor, toUnits, type Money } from "@rove/shared";
import { isValidClassicAddress } from "xrpl";
import type { EngineContext } from "./context";
import { plainDecimal } from "./currency";
import { XrplDestinationError } from "./errors";
import { findLine, findPaymentByInvoiceId, getAccountRoot, getTrustLines } from "./ledger";
import { assertPositiveSgd, toSettleResult } from "./settle";
import { submitTx } from "./submit";
import { buildIouPayment, invoiceIdFor } from "./tx";

/** lsfRequireDestTag on an AccountRoot. */
const LSF_REQUIRE_DEST_TAG = 0x00020000;

async function merchantPayment(
  ctx: EngineContext,
  input: { withdrawalId: string; merchantAddress: string; local: Money; destination: string; label: string },
): Promise<{ txHash: string }> {
  const local = assertPositiveSgd(input.local);
  const sgd = ctx.sgd();
  const wallet = await ctx.merchantWallet(input.merchantAddress);
  const invoiceId = invoiceIdFor(input.withdrawalId);
  const tx = buildIouPayment({ account: input.merchantAddress, destination: input.destination, amount: { ...sgd, value: local.amount }, invoiceId });
  const outcome = await submitTx(ctx, wallet, tx, {
    label: input.label,
    dedupe: () => findPaymentByInvoiceId(ctx.conn, { account: input.merchantAddress, destination: input.destination, invoiceId }),
  });
  toSettleResult(outcome, local, sgd); // exactly `local` XSGD left the account, or throw
  return { txHash: outcome.hash };
}

export async function sweepToRedemption(
  ctx: EngineContext,
  input: { withdrawalId: string; merchantAddress: string; local: Money },
): Promise<{ txHash: string }> {
  return merchantPayment(ctx, { ...input, destination: ctx.redemptionAddress(), label: `sweep ${input.withdrawalId} → redemption` });
}

/**
 * Can `address` receive `local` XSGD? Returns null if yes, else an error whose message a merchant can act on.
 * Read-only: the worker can call it when the withdrawal is requested (withdrawals.md §3a), before anything moves.
 */
export async function checkWalletDestination(
  ctx: EngineContext,
  input: { address: string; local: Money; merchantAddress?: string },
): Promise<XrplDestinationError | null> {
  const sgd = ctx.sgd();
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const how =
    `In your XRPL wallet (for example Xaman), add a trust line / token with issuer ${sgd.issuer} and currency XSGD ` +
    `(some wallets ask for the hex code ${sgd.currency}), then ask me again.`;
  if (!isValidClassicAddress(input.address)) {
    return new XrplDestinationError(`"${input.address}" isn't a valid XRPL address. It should start with "r", like rP4x…`, "invalid_address");
  }
  if (input.merchantAddress && input.address === input.merchantAddress) {
    return new XrplDestinationError("That's your Rove account itself. Send me the address of your own XRPL wallet instead.", "same_account");
  }
  const root = await getAccountRoot(ctx.conn, input.address);
  if (!root) {
    return new XrplDestinationError(
      `The wallet ${short(input.address)} isn't activated on the XRPL testnet yet. Fund it with some test XRP first (the testnet faucet works), then add XSGD. ${how}`,
      "no_account",
    );
  }
  if ((root.flags & LSF_REQUIRE_DEST_TAG) !== 0) {
    return new XrplDestinationError(
      `The wallet ${short(input.address)} requires a destination tag, which Rove withdrawals don't set. Use a personal wallet address instead of an exchange deposit address.`,
      "dest_tag_required",
    );
  }
  const line = findLine(await getTrustLines(ctx.conn, input.address, sgd.issuer), sgd.currency, sgd.issuer);
  if (!line) {
    return new XrplDestinationError(`The wallet ${short(input.address)} can't receive XSGD yet: it needs an XSGD trust line. ${how}`, "no_trust_line");
  }
  // Room on the line: limit − balance must cover the amount.
  const limit = plainDecimal(line.limit);
  const balance = plainDecimal(line.balance);
  const toCents = (v: string) => fromMinor(v.startsWith("-") ? 0n : toUnits(v, 2, "floor"), "SGD");
  if (cmp(add(toCents(balance), assertPositiveSgd(input.local)), toCents(limit)) > 0) {
    return new XrplDestinationError(
      `The wallet ${short(input.address)} has an XSGD trust line limit of ${limit}, too low to receive S$${input.local.amount} more. Raise the limit on its XSGD trust line and ask me again.`,
      "trust_line_limit",
    );
  }
  return null;
}

export async function sendToWallet(
  ctx: EngineContext,
  input: { withdrawalId: string; merchantAddress: string; local: Money; address: string },
): Promise<{ txHash: string }> {
  await ctx.merchantWallet(input.merchantAddress); // fail fast (no network) when this engine can't sign
  // A replayed withdrawal returns its earlier tx even if the wallet changed since.
  const invoiceId = invoiceIdFor(input.withdrawalId);
  const prior = await findPaymentByInvoiceId(ctx.conn, { account: input.merchantAddress, destination: input.address, invoiceId });
  if (!prior) {
    const problem = await checkWalletDestination(ctx, { address: input.address, local: input.local, merchantAddress: input.merchantAddress });
    if (problem) throw problem;
  }
  return merchantPayment(ctx, { ...input, destination: input.address, label: `send ${input.withdrawalId} → wallet ${input.address}` });
}
