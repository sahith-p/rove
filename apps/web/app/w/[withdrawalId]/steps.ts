// Pure mapping: withdrawal status (docs/specs/withdrawals.md §3c) → stepper steps + headline (§3d).
import type { Step } from "../../../components/StatusStepper";
import type { WithdrawalRes, WithdrawalStatus } from "@rove/shared";
import type { z } from "zod";
import { shortHash } from "../../../lib/ui/format";

export type WithdrawalView = z.infer<typeof WithdrawalRes>;

export const TERMINAL: ReadonlySet<WithdrawalStatus> = new Set(["completed", "failed", "returned", "cancelled"]);

export function isTerminal(s: WithdrawalStatus): boolean {
  return TERMINAL.has(s);
}

export function isProblem(s: WithdrawalStatus): boolean {
  return s === "failed" || s === "returned" || s === "cancelled";
}

/** Wallet withdrawals finish once the XSGD lands (§3c: "wallet withdrawals end here"). */
function isDone(v: WithdrawalView): boolean {
  return v.status === "completed" || (v.destination.kind === "xrpl_wallet" && v.status === "onchain_settled");
}

export type Tone = "waiting" | "progress" | "done" | "problem";

export function headline(v: WithdrawalView): { tone: Tone; label: string } {
  if (isDone(v)) return { tone: "done", label: v.destination.kind === "bank" ? "In your bank" : "In your wallet" };
  switch (v.status) {
    case "requested":
      return { tone: "waiting", label: v.needsStepUp ? "Needs your confirmation" : "Waiting for your 👍" };
    case "failed":
      return { tone: "problem", label: "Withdrawal failed" };
    case "returned":
      return { tone: "problem", label: "Returned by the bank" };
    case "cancelled":
      return { tone: "problem", label: "Cancelled" };
    default:
      return { tone: "progress", label: "On its way" };
  }
}

export function buildSteps(v: WithdrawalView): Step[] {
  const bank = v.destination.kind === "bank";
  const tx = v.sweepTxHash ? { detail: shortHash(v.sweepTxHash, 6), href: v.explorerUrl } : {};
  const requested: Step = { label: "Requested", state: "done", detail: "Confirmed" };
  const onXrpl: Step = { label: "On XRPL", state: "todo" };
  const sent: Step = { label: "Sent to bank", state: "todo" };
  const landed: Step = { label: bank ? "In your bank" : "In your wallet", state: "todo" };
  const steps = () => (bank ? [requested, onXrpl, sent, landed] : [requested, onXrpl, landed]);

  if (isDone(v)) {
    Object.assign(onXrpl, { state: "done" }, tx);
    Object.assign(sent, { state: "done", detail: "FAST payout" });
    Object.assign(landed, { state: "done", detail: bank ? v.bankRef ?? v.destination.label : v.destination.label, mono: bank && !!v.bankRef });
    return steps();
  }

  switch (v.status) {
    case "requested":
      Object.assign(requested, {
        state: "current",
        detail: v.needsStepUp ? "Waiting for your confirmation" : "Waiting for your 👍 in Messages",
      });
      break;
    case "approved":
      Object.assign(onXrpl, { state: "current", detail: "Funds held · sending XSGD" });
      break;
    case "onchain_pending":
      Object.assign(onXrpl, { state: "current", detail: "Settling on the XRPL testnet…", ...tx });
      break;
    case "onchain_settled":
      Object.assign(onXrpl, { state: "done" }, tx);
      Object.assign(sent, { state: "current", detail: "Starting FAST payout…" });
      break;
    case "payout_pending":
      Object.assign(onXrpl, { state: "done" }, tx);
      Object.assign(sent, { state: "done", detail: "FAST payout" });
      Object.assign(landed, { state: "current", detail: "Usually under a minute" });
      break;
    case "cancelled":
      Object.assign(requested, { state: "failed", detail: "Not confirmed in time" });
      break;
    case "failed":
      // Funds never left: it broke at or before the on-chain step.
      Object.assign(onXrpl, { state: "failed", detail: "Didn't go through" }, v.sweepTxHash ? tx : {});
      break;
    case "returned":
      Object.assign(onXrpl, { state: "done" }, tx);
      Object.assign(sent, { state: "done", detail: "FAST payout" });
      Object.assign(landed, { state: "failed", detail: "Returned by the bank" });
      break;
  }
  return steps();
}

/** "Money is back in your balance" explanation for the problem states. */
export function problemText(v: WithdrawalView): string {
  if (v.status === "cancelled") return "No money moved. It's all still in your balance.";
  return "Money is back in your balance. Say “withdraw” to try again.";
}
