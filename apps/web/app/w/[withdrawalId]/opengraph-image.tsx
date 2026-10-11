// Static preview for the withdrawal card (SH-B3): "Withdrawal" + amount + step + destination.
// OG image routes get neither searchParams nor the card's session token, and GET /api/withdrawals/:id is session-gated,
// so live data is only shown if the API answers without one. Fixture mode shows the demo withdrawal; otherwise the
// image stays generic (the state-aware title/description still come from the page's generateMetadata).
import { WithdrawalRes } from "@rove/shared";
import { ogCard, OG_CONTENT_TYPE, OG_SIZE } from "../../../lib/og/card";
import { getOwnJson } from "../../../lib/og/origin";
import { fixtureDest, withdrawalFixture } from "./_fixtures";
import { withdrawalCopy } from "./_preview";
import type { WithdrawalView } from "./steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "Rove withdrawal status";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

async function load(id: string): Promise<WithdrawalView | null> {
  const res = await getOwnJson(`/api/withdrawals/${encodeURIComponent(id)}`);
  if (res.ok) {
    const parsed = WithdrawalRes.safeParse(res.json);
    if (parsed.success) return parsed.data;
  }
  return process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1" ? withdrawalFixture(id, "requested", fixtureDest(id)) : null;
}

export default async function Image({ params }: { params: Promise<{ withdrawalId: string }> }) {
  const { withdrawalId } = await params;
  const view = await load(withdrawalId);
  if (!view) {
    return ogCard({
      eyebrow: "Withdrawal",
      headline: "Track your payout",
      detail: "From your Rove balance to your bank, via XRPL",
      footer: "Live status",
    });
  }
  const copy = withdrawalCopy(view);
  return ogCard({
    eyebrow: "Withdrawal",
    headline: copy.amount,
    amount: true,
    detail: view.destination.kind === "bank" ? "Rove balance → bank, via XRPL" : "Rove balance → your XRPL wallet",
    status: { label: copy.step.label, tone: copy.step.tone },
    footer: `To ${copy.to}`,
    meta: view.bankRef ?? undefined,
  });
}
