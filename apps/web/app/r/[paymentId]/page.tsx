// Receipt (customer) / sale card (merchant, ?view=merchant&t=)
// Owner: Sahith · Task: SH-A6 · Spec: docs/specs/web-app.md
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleAlert, RotateCw, SearchX } from "lucide-react";
import {
  Amount,
  Button,
  Card,
  CardAmount,
  CardFrame,
  CardTitle,
  IconBadge,
  LineItems,
  MerchantHeader,
  Notice,
  PageFooter,
  Row,
  Rows,
  StatusPill,
  type PillTone,
} from "../../../components";
import { previewMetadata } from "../../../lib/og/metadata";
import { fullPageHref, isCardMode } from "../../../lib/ui/card";
import { format, shortHash } from "../../../lib/ui/format";
import { readSession } from "../../../lib/ui/session";
import { SaveReceiptButton, SettlingPoller } from "./_client";
import { loadReceipt, PENDING, type ReceiptData } from "./_data";
import { METHOD_LABEL, receiptCopy } from "./_preview";
import styles from "./receipt.module.css";

type SearchParams = Record<string, string | string[] | undefined>;

interface PageProps {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<SearchParams>;
}

export const dynamic = "force-dynamic";

/** State-aware preview text (SH-B3): "Receipt S$12.50 · Paid ✓ · Ah Seng Chicken Rice". Image: opengraph-image.tsx. */
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ paymentId }, sp] = await Promise.all([params, searchParams]);
  const load = await loadReceipt(paymentId, { state: sp.state });
  const robots = { index: false, follow: false };
  if (load.kind !== "ok") return previewMetadata({ title: "Receipt · Rove", description: "Your Rove receipt.", robots });
  const { title, description } = receiptCopy(load.data, first(sp.view) === "merchant");
  return previewMetadata({ title, description, robots });
}

const dateTimeFmt = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Singapore",
});

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : shortHash(id, 6);
}

/** A valid `sale`/`shop` session for this payment, or null (→ customer view). */
function merchantSession(sp: SearchParams, paymentId: string): string | null {
  if (first(sp.view) !== "merchant") return null;
  const t = first(sp.t);
  try {
    const session = readSession(t, ["sale", "shop"]);
    if (!session) return null;
    if (session.scope === "sale" && session.ref && session.ref !== paymentId) return null;
    return t ?? null;
  } catch {
    return null; // e.g. TOKEN_SECRET unset in a preview deploy: fail closed to the customer view
  }
}

export default async function Page({ params, searchParams }: PageProps) {
  const [{ paymentId }, sp] = await Promise.all([params, searchParams]);
  const session = merchantSession(sp, paymentId);
  const load = await loadReceipt(paymentId, { session: session ?? undefined, state: sp.state });

  const card = isCardMode(sp);
  if (card && load.kind !== "ok") {
    return (
      <CardFrame eyebrow="Receipt">
        <CardTitle>{load.kind === "not_found" ? "Receipt not found" : "Couldn’t load this receipt"}</CardTitle>
      </CardFrame>
    );
  }
  if (card && load.kind === "ok") {
    return (
      <ReceiptCard data={load.data} merchant={session !== null} demo={load.demo} fullHref={fullPageHref(`/r/${encodeURIComponent(paymentId)}`, sp)} />
    );
  }

  if (load.kind === "not_found") {
    return (
      <main className={styles.page}>
        <section className={styles.empty}>
          <IconBadge>
            <SearchX size={22} strokeWidth={1.5} />
          </IconBadge>
          <h1 className={styles.emptyTitle}>Receipt not found</h1>
          <p className="muted">This link may be mistyped. Ask the shop to resend your receipt.</p>
        </section>
      </main>
    );
  }

  if (load.kind === "error") {
    return (
      <main className={styles.page}>
        <section className={styles.empty}>
          <IconBadge tone="error">
            <CircleAlert size={22} strokeWidth={1.5} />
          </IconBadge>
          <h1 className={styles.emptyTitle}>Couldn&rsquo;t load this receipt</h1>
          <p className="muted">Check your connection and try again.</p>
        </section>
        <Button href={`/r/${encodeURIComponent(paymentId)}`} fullWidth icon={<RotateCw size={18} strokeWidth={1.75} />}>
          Try again
        </Button>
      </main>
    );
  }

  return <Receipt data={load.data} merchant={session !== null} demo={load.demo} />;
}

function Receipt({ data, merchant, demo }: { data: ReceiptData; merchant: boolean; demo: boolean }) {
  const pending = PENDING.includes(data.status);
  const refunded = data.status === "refunded";
  const partial = data.status === "partially_refunded";
  const failed = data.status === "failed";
  const amountText = format(data.local);
  // Payer charged in their own currency (e.g. a US card): lead with what they paid, show what the shop got below.
  const foreignCharge = data.charge && data.charge.currency !== data.local.currency ? data.charge : null;
  const when = data.createdAt ? dateTimeFmt.format(new Date(data.createdAt)) : null;

  return (
    <main className={styles.page}>
      {pending ? <SettlingPoller /> : null}

      {merchant ? (
        <header className={styles.saleHead}>
          <span className="eyebrow">New sale</span>
          <h1 className={`twoTone ${styles.headline}`}>
            <span>
              {amountText} from {data.payerName ?? "a customer"}
            </span>
            <span>{pending ? "Settling to your balance…" : failed ? "Payment failed" : refunded ? "Refunded" : "In your Rove balance"}</span>
          </h1>
          <ReceiptStatus status={data.status} />
        </header>
      ) : (
        <>
          <MerchantHeader name={data.merchantName} verified={data.merchantVerified === true} />
          <section className={styles.hero} aria-label="Status">
            <ReceiptStatus status={data.status} />
            {foreignCharge ? (
              <Amount
                label="You paid"
                money={foreignCharge}
                sub={`${amountText} to ${data.merchantName} · no card FX fees`}
                className={refunded ? styles.struck : undefined}
              />
            ) : (
              <Amount label="Total" money={data.local} className={refunded ? styles.struck : undefined} />
            )}
          </section>
        </>
      )}

      {refunded ? (
        <Notice variant="info" title="Refunded">
          {data.refunded ? `${format(data.refunded)} was refunded` : "This payment was refunded in full"} to the original
          payment method.
        </Notice>
      ) : null}
      {partial ? (
        <Notice variant="info" title="Partially refunded">
          {data.refunded ? `${format(data.refunded)} of ${amountText} was refunded` : "Part of this payment was refunded"} to
          the original payment method.
        </Notice>
      ) : null}
      {failed ? (
        <Notice variant="error" title="Payment failed">
          This payment didn&rsquo;t complete.
        </Notice>
      ) : null}

      <Card label={merchant ? "Sale" : "Order"}>
        <LineItems lines={data.lines} total={data.local} totalLabel={merchant ? "Sale total" : "Total"} />
      </Card>

      <Rows label="Details">
        {merchant ? <Row label="Shop" value={data.merchantName} /> : null}
        <Row label="Paid with" value={METHOD_LABEL[data.method]} />
        {when ? <Row label="Date" value={when} /> : null}
        <Row label="Payment ID" value={<span title={data.paymentId}>{shortId(data.paymentId)}</span>} mono />
        {data.explorerUrl ? (
          <Row
            label="XRPL"
            mono
            value={
              <a className={styles.link} href={data.explorerUrl} target="_blank" rel="noopener noreferrer">
                {data.settleTxHash ? shortHash(data.settleTxHash) : "View"}
                <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="sr-only"> View on XRPL</span>
              </a>
            }
          />
        ) : pending ? (
          <Row label="XRPL" value="Pending…" tone="muted" />
        ) : null}
      </Rows>

      {merchant && (data.status === "settled" || partial) ? (
        <p className={styles.hint}>To refund, text Rove &lsquo;refund this&rsquo;.</p>
      ) : null}

      {!pending && !failed ? <SaveReceiptButton className={styles.noPrint} /> : null}

      <PageFooter demo={demo} className={styles.footer}>
        Settles on XRPL
      </PageFooter>
    </main>
  );
}

function ReceiptStatus({ status }: { status: ReceiptData["status"] }) {
  if (PENDING.includes(status)) {
    return (
      <StatusPill tone="pending" role="status" className={styles.pill}>
        Settling…
      </StatusPill>
    );
  }
  const map: Record<string, [string, PillTone]> = {
    settled: ["Paid", "success"],
    partially_refunded: ["Paid · partly refunded", "neutral"],
    refunded: ["Refunded", "neutral"],
    failed: ["Failed", "error"],
  };
  const [label, tone] = map[status] ?? ["", "neutral"];
  if (!label) return null;
  return (
    <StatusPill tone={tone} className={styles.pill} icon={tone === "success" ? <Check size={13} strokeWidth={2.5} /> : undefined}>
      {label}
    </StatusPill>
  );
}

/** ?card=1: merchant (or "New sale") + amount + status. Essentials only. */
function ReceiptCard({ data, merchant, demo }: { data: ReceiptData; merchant: boolean; demo: boolean; fullHref: string }) {
  const pending = PENDING.includes(data.status);
  const foreignCharge = data.charge && data.charge.currency !== data.local.currency ? data.charge : null;
  const shown = merchant ? data.local : (foreignCharge ?? data.local);
  return (
    <CardFrame
      eyebrow={<span>{merchant ? "New sale" : data.merchantName}</span>}
      status={<ReceiptStatus status={data.status} />}
      demo={demo}
      label={merchant ? "New sale" : "Receipt"}
    >
      {pending ? <SettlingPoller /> : null}
      <CardAmount money={shown} struck={data.status === "refunded"} />
    </CardFrame>
  );
}
