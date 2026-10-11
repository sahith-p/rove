// Display labels for /shop. Pure functions, no money math.
import type { MeData } from "./_fixtures";

type PaymentRow = MeData["recentPayments"][number];
type WithdrawalRow = MeData["withdrawals"][number];
export type Tone = "ok" | "busy" | "bad" | "quiet";

export const SOURCE_LABEL: Record<PaymentRow["source"], string> = {
  invoice: "Invoice",
  one_time_qr: "One-time code",
  fixed_qr: "Shop QR",
  pay_request: "Pay request",
};

export const PAYMENT_STATUS: Record<PaymentRow["status"], { label: string; tone: Tone }> = {
  created: { label: "Pending", tone: "busy" },
  authorized: { label: "Settling", tone: "busy" },
  settling: { label: "Settling", tone: "busy" },
  settled: { label: "Paid", tone: "ok" },
  partially_refunded: { label: "Part refunded", tone: "quiet" },
  refunded: { label: "Refunded", tone: "quiet" },
  failed: { label: "Failed", tone: "bad" },
};

export const WITHDRAWAL_STATUS: Record<WithdrawalRow["status"], { label: string; tone: Tone }> = {
  requested: { label: "Needs confirm", tone: "busy" },
  approved: { label: "Approved", tone: "busy" },
  onchain_pending: { label: "On XRPL…", tone: "busy" },
  onchain_settled: { label: "On XRPL ✓", tone: "busy" },
  payout_pending: { label: "Sending to bank", tone: "busy" },
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  returned: { label: "Returned", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "quiet" },
};

// Longest first so "+852…" isn't read as "+85".
const CALLING_CODES = ["852", "853", "886", "880", "971", "1", "7", "44", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "91"];

/** "+6591234567" → "+65 •••• 4567". Never shows more than the country code and last 4 digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5) return "••••";
  const cc = CALLING_CODES.slice()
    .sort((a, b) => b.length - a.length)
    .find((c) => digits.startsWith(c) && digits.length - c.length >= 4);
  return `${cc ? `+${cc} ` : ""}•••• ${digits.slice(-4)}`;
}

/** "hawker" → "Hawker". Merchant-written text, display only. */
export function categoryLabel(category: string | null): string | null {
  const c = category?.trim().replace(/[_-]+/g, " ");
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : null;
}
