// /pay/[code]?card=1: the compact in-card layout (merchant · big amount · code · "Pay" → full page in Safari).
// Server component: the invoice comes from the same server read as the preview metadata, never from the URL.
import { Check, Clock, SearchX, ShieldCheck, X } from "lucide-react";
import { CardAmount, CardFrame, CardLine, CardLink, CardTitle, StatusPill } from "../../../components";
import { CardRefresh } from "../../../components/CardRefresh";
import { AppleLogo } from "../../../components/icons";
import type { InvoiceView } from "./_fixtures";
import styles from "./pay.module.css";

export function PayCard({ invoice, code, fullHref, demo }: { invoice: InvoiceView | null; code: string; fullHref: string; demo: boolean }) {
  if (!invoice) {
    return (
      <CardFrame eyebrow="Payment" demo={demo}>
        <SearchX size={22} strokeWidth={1.5} aria-hidden="true" />
        <CardTitle sub="Check the code, or ask the shop for a new one.">Code not found</CardTitle>
        <CardLine mono>{code}</CardLine>
      </CardFrame>
    );
  }

  const open = invoice.status === "open" && Date.parse(invoice.expiresAt) > Date.now();
  const merchant = (
    <>
      {invoice.merchant.verified ? <ShieldCheck size={14} strokeWidth={1.75} className={styles.cardShield} aria-label="Verified on XRPL" /> : null}
      <span>{invoice.merchant.name}</span>
    </>
  );
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
      <CardLine mono>
        {invoice.code}
        {invoice.lines.length ? ` · ${invoice.lines.reduce((n, l) => n + l.qty, 0)} items` : ""}
      </CardLine>
    </CardFrame>
  );
}
