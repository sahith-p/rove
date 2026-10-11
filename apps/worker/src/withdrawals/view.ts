// Withdrawal → WithdrawalView (the shape of InternalCreateWithdrawalRes, the withdrawal card and /w/<id>).
// Shared helper for NI-C3/NI-C4. apps/web/app/api/_lib/views.ts has the same mapping for GET /api/withdrawals/:id.

import type { BankAccount, Withdrawal } from "@rove/shared";
import type { WithdrawalView } from "../contracts";
import type { WorkerDeps } from "../deps";

/** "DBS ••••1234"; PayNow proxies have no bank name: "PayNow ••••1234"; an IBAN without one: "IBAN ••••3000". */
export function bankLabel(b: Pick<BankAccount, "bankName" | "last4"> & { type?: BankAccount["type"] }): string {
  return `${b.bankName ?? (b.type === "iban" ? "IBAN" : "PayNow")} ••••${b.last4}`;
}

/** "rP4x…9Kd": enough to recognise, short enough for a card line. */
export function walletLabel(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-3)}`;
}

export async function toWithdrawalView(deps: Pick<WorkerDeps, "db" | "settlement">, w: Withdrawal): Promise<WithdrawalView> {
  let label: string;
  if (w.destination.kind === "bank") {
    const bank = await deps.db.getBankAccount(w.destination.bankAccountId);
    label = bank ? bankLabel(bank) : "Bank account";
  } else {
    label = walletLabel(w.destination.address);
  }

  const view: WithdrawalView = {
    id: w.id,
    amount: w.amount,
    fee: w.fee,
    destination: { kind: w.destination.kind, label },
    status: w.status,
    needsStepUp: w.needsStepUp,
    updatedAt: w.updatedAt,
  };
  if (w.sweepTxHash) {
    view.sweepTxHash = w.sweepTxHash;
    view.explorerUrl = deps.settlement.explorerUrl(w.sweepTxHash);
  }
  if (w.bankRef) view.bankRef = w.bankRef;
  if (w.failureReason) view.failureReason = w.failureReason;
  return view;
}
