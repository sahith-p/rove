// Domain → API view mappers shared by GET /api/me (NI-B5) and GET /api/withdrawals/:id (NI-B6).
// toWithdrawalView mirrors apps/worker/src/withdrawals/view.ts (same labels), so the card and the page agree.

import type { z } from "zod";
import type { BankAccountViewZ, WithdrawalViewZ } from "@rove/shared";
import type { BankAccount, Withdrawal } from "@rove/shared";
import type { WebDeps } from "./deps";

export type WithdrawalView = z.infer<typeof WithdrawalViewZ>;
export type BankAccountView = z.infer<typeof BankAccountViewZ>;

/** "DBS ••••1234"; PayNow proxies have no bank name: "PayNow ••••1234". */
export function bankLabel(b: Pick<BankAccount, "bankName" | "last4">): string {
  return `${b.bankName ?? "PayNow"} ••••${b.last4}`;
}

/** "rP4x…9Kd" */
export function walletLabel(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-3)}`;
}

export function toBankAccountView(b: BankAccount): BankAccountView {
  return { id: b.id, type: b.type, bankName: b.bankName, last4: b.last4, holderName: b.holderName, status: b.status, isDefault: b.isDefault };
}

export async function toWithdrawalView(deps: Pick<WebDeps, "db" | "settlement">, w: Withdrawal): Promise<WithdrawalView> {
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
