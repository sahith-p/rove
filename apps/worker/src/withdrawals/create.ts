// Create a withdrawal (status `requested`; no money moves). Owner: Nithya · Task: NI-C3.
// Spec: docs/specs/withdrawals.md §3a, docs/specs/corridors.md. POST /internal/withdrawals, called by the agent's
// propose_withdrawal tool. amount null = everything available; destination null = default bank account. Checks, in
// order: shop live → amount (≥ min, ≤ available, today's total ≤ daily max) → destination (bank on file that can
// receive the shop's currency / wallet address) → fee 0 → needsStepUp (first withdrawal, bank account < 24h old, amount
// > step-up) → db.insertWithdrawal → toWithdrawalView.
// Limits are per currency from the registry (SGD S$1 / S$200 / S$2,000 = WITHDRAWAL_LIMITS; EUR €1 / €150 / €1,500), and
// bank payouts go to the currency's partner (registry `payout`: SGD → StraitsX/PayNow, EUR → SEPA; USD has none yet,
// so USD shops withdraw to a wallet). Messages are in the shop's currency via format().
// Every refusal is a UserFacingError whose message the agent says as is ("You have S$42.10 available to withdraw.").
//
// Wallet destinations: when the engine has the real engine's read-only `checkWalletDestination` (activated account,
// trust line for the shop currency's stablecoin with room; not on the SettlementEngine interface or the mock, so it's feature-detected), refuse here
// with its merchant-readable message. Otherwise (mock, or the pre-check itself errors) sendToWallet checks again at
// execute time and the withdrawal fails cleanly with the hold released.

import {
  add,
  BANK_ACCOUNT_PARTNER,
  bankAccountTypesFor,
  cmp,
  format,
  isPositive,
  money,
  payoutPartnerIdFor,
  sub,
  withdrawalLimitsFor,
  zero,
  type BankAccount,
  type Currency,
  type Merchant,
  type Money,
  type SettlementEngine,
  type Withdrawal,
} from "@rove/shared";
import type { InternalCreateWithdrawalReq, WithdrawalView } from "../contracts";
import type { WorkerDeps } from "../deps";
import { UserFacingError } from "../errors";
import { toWithdrawalView } from "./view";

const DAY_MS = 24 * 3600 * 1000;
/** Same pattern as the contract's WithdrawalDestinationZ, for callers that skip the HTTP layer (auto-withdraw, scripts). */
const XRPL_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export const NO_BANK_ACCOUNT_MESSAGE = "Add your bank first: say 'add my bank'.";

/** The demo limits in the merchant's currency, from the registry (SGD: S$1 / S$200 / S$2,000; EUR: €1 / €150 / €1,500). */
export function withdrawalLimits(currency: Currency): { min: Money; stepUpAbove: Money; dailyMax: Money } {
  return withdrawalLimitsFor(currency);
}

/** What a shop in `currency` can add as a bank account, for the agent to say. */
function bankKindFor(currency: Currency): string {
  return bankAccountTypesFor(currency).includes("iban") ? "your IBAN" : "your PayNow or bank account";
}

export async function createWithdrawal(deps: WorkerDeps, body: InternalCreateWithdrawalReq): Promise<WithdrawalView> {
  const log = deps.log.child("withdrawals");
  const merchant = await liveMerchant(deps, body.merchantId);
  const amount = await checkAmount(deps, merchant, body.amount);
  const { destination, bank } = await checkDestination(deps, merchant, body.destination, amount);
  const needsStepUp = await stepUpNeeded(deps, merchant, amount, bank);

  const w = await deps.db.insertWithdrawal({
    merchantId: merchant.id,
    amount,
    fee: zero(merchant.currency), // FAST/PayNow and SEPA Instant payouts are free; the card still shows "Fee S$0.00" / "Fee €0.00"
    destination,
    needsStepUp,
  });
  log.info("withdrawal requested", { id: w.id, merchantId: w.merchantId, amount: w.amount.amount, destination: destination.kind, needsStepUp });
  return toWithdrawalView(deps, w);
}

async function liveMerchant(deps: WorkerDeps, merchantId: string): Promise<Merchant> {
  const merchant = await deps.db.getMerchant(merchantId);
  if (!merchant) throw new UserFacingError("merchant_not_found", "I couldn't find that shop.", 404);
  if (merchant.status !== "live" || !merchant.xrplAddress) {
    throw new UserFacingError("merchant_not_live", "Your shop isn't set up yet. Finish setting it up, then you can withdraw.");
  }
  return merchant;
}

async function checkAmount(deps: WorkerDeps, merchant: Merchant, requested: string | null): Promise<Money> {
  const limits = withdrawalLimits(merchant.currency);
  const { available } = await deps.db.getBalance(merchant.id);

  let amount: Money;
  if (requested === null) {
    if (!isPositive(available)) throw new UserFacingError("nothing_to_withdraw", `You have ${format(available)} available to withdraw right now.`);
    amount = available;
  } else {
    try {
      amount = money(requested, merchant.currency);
    } catch {
      throw new UserFacingError("invalid_amount", "Amounts go to the cent, like 12.50.");
    }
  }

  if (cmp(amount, limits.min) < 0) {
    throw new UserFacingError(
      "below_minimum",
      requested === null
        ? `You have ${format(available)} available; the minimum withdrawal is ${format(limits.min)}.`
        : `The minimum withdrawal is ${format(limits.min)}.`,
    );
  }
  if (cmp(amount, available) > 0) {
    throw new UserFacingError("insufficient_funds", `You have ${format(available)} available to withdraw.`);
  }

  const today = await deps.db.withdrawnToday(merchant.id);
  if (cmp(add(today, amount), limits.dailyMax) > 0) {
    const left = sub(limits.dailyMax, today);
    throw new UserFacingError(
      "daily_limit",
      cmp(left, limits.min) >= 0
        ? `You can withdraw up to ${format(limits.dailyMax)} a day, and you have ${format(left)} left today.`
        : `You've reached today's ${format(limits.dailyMax)} withdrawal limit. Try again tomorrow.`,
    );
  }
  return amount;
}

async function checkDestination(
  deps: WorkerDeps,
  merchant: Merchant,
  requested: InternalCreateWithdrawalReq["destination"],
  amount: Money,
): Promise<{ destination: Withdrawal["destination"]; bank: BankAccount | null }> {
  if (requested?.kind === "xrpl_wallet") {
    const address = requested.address.trim();
    if (!XRPL_ADDRESS.test(address)) {
      throw new UserFacingError("invalid_wallet", "That doesn't look like an XRPL address. It starts with 'r', like rP4x…");
    }
    if (address === merchant.xrplAddress) {
      throw new UserFacingError("invalid_wallet", "That's your Rove account itself. Send me the address of your own XRPL wallet.");
    }
    await checkWalletCanReceive(deps, merchant, address, amount);
    return { destination: { kind: "xrpl_wallet", address }, bank: null };
  }

  // Bank payouts need a payout partner for the shop's currency (registry `payout`).
  const partner = payoutPartnerIdFor(merchant.currency);
  if (!partner) {
    throw new UserFacingError(
      "no_bank_payout",
      `Bank withdrawals in ${merchant.currency} aren't available yet. I can send it to your own XRPL wallet instead: say 'send 20 to my wallet r…'.`,
    );
  }

  const bank = requested ? await deps.db.getBankAccount(requested.bankAccountId) : await deps.db.getDefaultBankAccount(merchant.id);
  if (!bank || bank.merchantId !== merchant.id) {
    if (!requested) throw new UserFacingError("no_bank_account", NO_BANK_ACCOUNT_MESSAGE);
    throw new UserFacingError("bank_account_not_found", "I couldn't find that bank account. Say 'add my bank' to add it.");
  }
  if (bank.status === "failed") {
    throw new UserFacingError("bank_account_failed", "That bank account didn't pass the bank's check. Say 'add my bank' to add it again.");
  }
  if (BANK_ACCOUNT_PARTNER[bank.type] !== partner) {
    // e.g. a PayNow account on a shop that now takes EUR: its partner can't pay that currency out.
    throw new UserFacingError(
      "bank_account_wrong_currency",
      `That bank account can't receive ${merchant.currency}. Say 'add my bank' to add ${bankKindFor(merchant.currency)}.`,
    );
  }
  return { destination: { kind: "bank", bankAccountId: bank.id }, bank };
}

/** What @rove/xrpl's XrplDestinationError looks like (structural, so the worker doesn't load xrpl.js for a type). */
interface DestinationProblem {
  message: string;
  reason?: string;
}
type WalletPreCheck = (input: { address: string; local: Money; merchantAddress?: string }) => Promise<DestinationProblem | null>;

function walletPreCheck(engine: SettlementEngine): WalletPreCheck | null {
  const fn = (engine as SettlementEngine & { checkWalletDestination?: WalletPreCheck }).checkWalletDestination;
  return typeof fn === "function" ? fn.bind(engine) : null;
}

const isDestinationProblem = (err: unknown): err is Error & DestinationProblem => err instanceof Error && err.name === "XrplDestinationError";

/** withdrawals.md §3a / settlement-xrpl.md §7: the wallet must be able to receive the shop currency's stablecoin (when the engine can tell). */
async function checkWalletCanReceive(deps: WorkerDeps, merchant: Merchant, address: string, amount: Money): Promise<void> {
  const check = walletPreCheck(deps.settlement);
  if (!check) return; // mock engine: sendToWallet decides at execute time
  let problem: DestinationProblem | null;
  try {
    problem = await check({ address, local: amount, merchantAddress: merchant.xrplAddress ?? undefined });
  } catch (err) {
    if (!isDestinationProblem(err)) {
      deps.log.child("withdrawals").warn("wallet pre-check failed; sendToWallet checks again at execute time", {
        merchantId: merchant.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    problem = err;
  }
  if (!problem) return;
  const code = problem.reason === "invalid_address" || problem.reason === "same_account" ? "invalid_wallet" : "wallet_cannot_receive";
  throw new UserFacingError(code, problem.message);
}

/** withdrawals.md §3a: first withdrawal, a bank account added < 24h ago, or more than S$200 → confirm on the web page. */
async function stepUpNeeded(deps: WorkerDeps, merchant: Merchant, amount: Money, bank: BankAccount | null): Promise<boolean> {
  if (cmp(amount, withdrawalLimits(merchant.currency).stepUpAbove) > 0) return true;
  if (bank && deps.now().getTime() - Date.parse(bank.createdAt) < DAY_MS) return true;
  return !(await deps.db.hasCompletedWithdrawal(merchant.id));
}
