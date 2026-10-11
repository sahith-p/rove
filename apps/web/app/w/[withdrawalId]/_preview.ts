// Preview text for /w/[withdrawalId] (SH-B3), shared by generateMetadata and opengraph-image so they agree.
import { format } from "@rove/shared";
import { withdrawalStep } from "../../../lib/og/labels";
import type { WithdrawalView } from "./steps";

export function withdrawalCopy(v: WithdrawalView) {
  const amount = format(v.amount);
  const step = withdrawalStep(v);
  const to = v.destination.kind === "bank" ? v.destination.label : `XRPL wallet ${v.destination.label}`;
  const title = `Withdrawal ${amount} · ${step.text}`;
  const description =
    step.tone === "success"
      ? `${amount} arrived in ${to}.`
      : step.tone === "error"
        ? `${amount} to ${to}: ${step.label.toLowerCase()}. The money is back in your balance.`
        : v.status === "cancelled"
          ? "No money moved. It's all still in your balance."
          : `${amount} to ${to} · ${step.label}.`;
  return { amount, step, to, title, description };
}
