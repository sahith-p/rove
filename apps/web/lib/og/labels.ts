// Pure state → label mappings shared by the OG images and each page's generateMetadata (SH-B3),
// so the preview image and the preview title always agree.
import type { InvoicePublicRes, PaymentStatusRes, WithdrawalRes } from "@rove/shared";
import type { z } from "zod";
import type { OgTone } from "./card";

export interface StatusLabel {
  label: string;
  tone: OgTone;
  /** Same label for plain-text titles, with a ✓ when it's done ("Paid ✓"). */
  text: string;
}

const done = (label: string): StatusLabel => ({ label, tone: "success", text: `${label} ✓` });
const plain = (label: string, tone: OgTone): StatusLabel => ({ label, tone, text: label });

type Line = { name: string; qty: number };

/**
 * "2× Chicken rice, 1× Barley drink". Whole lines only, as many as fit in `budget` characters, then "+N more",
 * so the image never cuts an item name in half. Empty string for no lines.
 */
export function itemSummary(lines: readonly Line[], budget = 46): string {
  const parts = lines.map((l) => `${l.qty}× ${l.name.trim()}`);
  const shown: string[] = [];
  for (const p of parts) {
    const rest = parts.length - shown.length - 1;
    const next = [...shown, p].join(", ") + (rest > 0 ? ` +${rest} more` : "");
    if (shown.length > 0 && next.length > budget) break;
    shown.push(p);
  }
  const rest = parts.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

export function invoiceStatus(status: z.infer<typeof InvoicePublicRes>["status"]): StatusLabel {
  switch (status) {
    case "paid":
      return done("Paid");
    case "expired":
      return plain("Expired", "neutral");
    case "cancelled":
      return plain("Cancelled", "neutral");
    default:
      return plain("Open", "pending");
  }
}

export function paymentStatus(status: z.infer<typeof PaymentStatusRes>["status"]): StatusLabel {
  switch (status) {
    case "settled":
      return done("Paid");
    case "refunded":
      return plain("Refunded", "neutral");
    case "partially_refunded":
      return plain("Partly refunded", "neutral");
    case "failed":
      return plain("Failed", "error");
    default:
      return plain("Settling", "pending");
  }
}

type Withdrawal = Pick<z.infer<typeof WithdrawalRes>, "status" | "destination">;

/** Where the withdrawal is, in the stepper's words (docs/specs/withdrawals.md §3c–3d). */
export function withdrawalStep(w: Withdrawal): StatusLabel {
  const bank = w.destination.kind === "bank";
  if (w.status === "completed" || (!bank && w.status === "onchain_settled")) return done(bank ? "In your bank" : "In your wallet");
  switch (w.status) {
    case "requested":
      return plain("Waiting for confirmation", "pending");
    case "approved":
    case "onchain_pending":
      return plain("On XRPL", "pending");
    case "onchain_settled":
    case "payout_pending":
      return plain("Sent to bank", "pending");
    case "failed":
      return plain("Failed", "error");
    case "returned":
      return plain("Returned by the bank", "error");
    case "cancelled":
      return plain("Cancelled", "neutral");
    default:
      return plain("In progress", "pending");
  }
}
