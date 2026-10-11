// Demo fixtures for /w/[withdrawalId] while GET /api/withdrawals/:id (NI-B6) returns 501.
// Only used when NEXT_PUBLIC_DEMO_FIXTURES=1. Every object is a valid WithdrawalViewZ (checked at module load in dev).
import { WithdrawalViewZ, type WithdrawalStatus } from "@rove/shared";
import type { WithdrawalView } from "./steps";

export type FixtureDest = "bank" | "xrpl_wallet";

const TX_HASH = "8F3A1C9E2B7D4F6A0E5C3B1D9F7A2E4C6B8D0F1A3C5E7B9D2F4A6C8E0B1D3F5A";
const EXPLORER = `https://testnet.xrpl.org/transactions/${TX_HASH}`;

/** Happy-path order the demo walks through after the step-up confirm. Wallet withdrawals end on-chain. */
export const FIXTURE_FLOW: Record<FixtureDest, WithdrawalStatus[]> = {
  bank: ["requested", "approved", "onchain_pending", "onchain_settled", "payout_pending", "completed"],
  xrpl_wallet: ["requested", "approved", "onchain_pending", "completed"],
};

const STATUSES = new Set<string>(WithdrawalViewZ.shape.status.options);

export function isFixtureStatus(s: string | undefined): s is WithdrawalStatus {
  return !!s && STATUSES.has(s);
}

/** Wallet fixture when the id says so (`wd_wallet…`) or `?dest=wallet`. */
export function fixtureDest(id: string, dest?: string): FixtureDest {
  return dest === "wallet" || id.startsWith("wd_wallet") ? "xrpl_wallet" : "bank";
}

export function withdrawalFixture(
  id: string,
  status: WithdrawalStatus = "requested",
  dest: FixtureDest = "bank",
  needsStepUp = true,
): WithdrawalView {
  const flow = FIXTURE_FLOW[dest];
  const reached = (s: WithdrawalStatus) => {
    const at = flow.indexOf(status);
    return at >= 0 && at >= flow.indexOf(s);
  };
  const onChain = reached(dest === "bank" ? "onchain_settled" : "completed") || status === "returned";

  const view: WithdrawalView = {
    id,
    amount: { amount: "118.40", currency: "SGD" },
    fee: { amount: "0.00", currency: "SGD" },
    destination: dest === "bank" ? { kind: "bank", label: "DBS ••••1234" } : { kind: "xrpl_wallet", label: "rP4x…9Kd" },
    status,
    needsStepUp,
    updatedAt: new Date().toISOString(),
    ...(onChain ? { sweepTxHash: TX_HASH, explorerUrl: EXPLORER } : {}),
    ...(status === "completed" && dest === "bank" ? { bankRef: "FAST-881245" } : {}),
    ...(status === "failed" ? { failureReason: "The XRPL payment didn't go through." } : {}),
    ...(status === "returned" ? { failureReason: "The bank returned the payout." } : {}),
    ...(status === "cancelled" ? { failureReason: "The request expired before it was confirmed." } : {}),
  };
  if (process.env.NODE_ENV !== "production") WithdrawalViewZ.parse(view);
  return view;
}

/** Next status in the demo flow, or null when it should stop (terminal, or waiting for the step-up). */
export function nextFixtureStatus(view: WithdrawalView): WithdrawalStatus | null {
  const flow = FIXTURE_FLOW[view.destination.kind];
  const at = flow.indexOf(view.status);
  if (at < 0 || at === flow.length - 1) return null;
  return flow[at + 1] ?? null;
}
