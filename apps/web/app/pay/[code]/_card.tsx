// /pay/[code]?card=1: the compact in-card layout (merchant · big amount · code · "Pay" → full page in Safari).
// Server component: the invoice comes from the same server read as the preview metadata, never from the URL.
import { Check, Clock, SearchX, X } from "lucide-react";
import { CardAmount, CardFrame, CardLink, CardTitle, StatusPill } from "../../../components";
import { CardRefresh } from "../../../components/CardRefresh";
import { AppleLogo } from "../../../components/icons";
import type { InvoiceView } from "./_fixtures";

export function PayCard({ invoice, code, fullHref, demo }: { invoice: InvoiceView | null; code: string; fullHref: string; demo: boolean }) {
  if (!invoice) {
    return (
      <CardFrame eyebrow="Payment" demo={demo}>
        <SearchX size={22} strokeWidth={1.5} aria-hidden="true" />
        <CardTitle>Code not found</CardTitle>
      </CardFrame>
    );
  }

  const open = invoice.status === "open" && Date.parse(invoice.expiresAt) > Date.now();
  const merchant = <span>{invoice.merchant.name}</span>;
  const status =
    invoice.status === "paid" ? (
      <StatusPill tone="success" icon={<Check size={13} strokeWidth={2.5} />}>
        Paid
      </StatusPill>
    ) : invoice.status === "cancelled" ? (
      <StatusPill tone="neutral" icon={<X size={13} strokeWidth={2} />}>
        Cancelled
      </StatusPill>
    ) : !open ? (
      <StatusPill tone="neutral" icon={<Clock size={13} strokeWidth={1.75} />}>
        Expired
      </StatusPill>
    ) : null;

  return (
    <CardFrame
      eyebrow={merchant}
      status={status}
      demo={demo}
      label={`Pay ${invoice.merchant.name}`}
      action={
        open ? (
          <CardLink href={fullHref} icon={<AppleLogo size={17} />}>
            Pay
          </CardLink>
        ) : undefined
      }
    >
      {open ? <CardRefresh ms={4000} /> : null}
      <CardAmount money={invoice.total} struck={!open && invoice.status !== "paid"} />
    </CardFrame>
  );
}
