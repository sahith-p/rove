// Preview text for /r/[paymentId] (SH-B3), shared by generateMetadata and opengraph-image so they agree.
import { format } from "@rove/shared";
import { itemSummary, paymentStatus } from "../../../lib/og/labels";
import type { ReceiptData } from "./_data";

export const METHOD_LABEL: Record<ReceiptData["method"], string> = {
  apple_pay: "Apple Pay",
  card: "Card",
  bnb: "BNB Chain wallet",
  ausd: "AUSD wallet (no gas)",
};

export function receiptCopy(data: ReceiptData, merchantView = false) {
  // Lead with what the payer was charged (their currency) when it differs from what the shop received.
  const foreign = data.charge && data.charge.currency !== data.local.currency ? data.charge : null;
  const amount = format(foreign ?? data.local);
  const local = format(data.local);
  const status = paymentStatus(data.status);
  const items = itemSummary(data.lines);
  const title = merchantView
    ? `Sale ${local} · ${status.text}`
    : `Receipt ${amount} · ${status.text} · ${data.merchantName}`;
  const description =
    data.status === "settled"
      ? `${foreign ? `${local} to ${data.merchantName}, no card FX fees.` : `Paid to ${data.merchantName}.`} Settled on XRPL.`
      : data.status === "refunded"
        ? `This payment to ${data.merchantName} was refunded to the original payment method.`
        : data.status === "partially_refunded"
          ? `Part of this payment to ${data.merchantName} was refunded.`
          : data.status === "failed"
            ? `This payment to ${data.merchantName} didn't complete.`
            : `Settling to ${data.merchantName} on XRPL.`;
  return { amount, local, foreign, status, items, title, description };
}
