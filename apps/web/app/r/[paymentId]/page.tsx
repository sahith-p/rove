// Receipt (customer) / sale card (merchant, ?view=merchant&t=)
// Owner: Sahith · Task: SH-A6 · Spec: docs/specs/web-app.md
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Amount, Button, Card, LineItems, MerchantHeader, Notice } from "../../../components";
import { previewMetadata } from "../../../lib/og/metadata";
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

  if (load.kind === "not_found") {
    return (
      <main className={styles.page}>
        <Card className={styles.empty}>
          <h2>Receipt not found</h2>
          <p className="muted">This link may be mistyped. Ask the shop to resend your receipt.</p>
        </Card>
      </main>
    );
  }

  if (load.kind === "error") {
    return (
      <main className={styles.page}>
        <Card className={styles.empty}>
          <h2>Couldn&rsquo;t load this receipt</h2>
          <p className="muted">Check your connection and try again.</p>
        </Card>
        <Button href={`/r/${encodeURIComponent(paymentId)}`} fullWidth>
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
          <span className={styles.eyebrow}>New sale</span>
          <h1 className={styles.headline}>
            <span>
              {amountText} from {data.payerName ?? "a customer"}
            </span>
            <span className={styles.headlineMuted}>
              {pending ? "Settling to your balance…" : failed ? "Payment failed" : refunded ? "Refunded" : "In your Rove balance"}
            </span>
          </h1>
        </header>
      ) : (
        <MerchantHeader name={data.merchantName} verified={data.merchantVerified === true} />
      )}

      <section className={merchant ? `${styles.hero} ${styles.heroStart}` : styles.hero} aria-label="Status">
        <StatusPill status={data.status} />
        {merchant ? null : foreignCharge ? (
          <div className={styles.paidIn}>
            <span className={styles.paidLabel}>You paid</span>
            <Amount
              money={foreignCharge}
              sub={`${amountText} to ${data.merchantName} · no card FX fees`}
              className={refunded ? styles.struck : undefined}
            />
          </div>
        ) : (
          <Amount money={data.local} className={refunded ? styles.struck : undefined} />
        )}
      </section>

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

      <Card>
        <LineItems lines={data.lines} total={data.local} totalLabel={merchant ? "Sale total" : "Total"} />
      </Card>

      <Card>
        <dl className={styles.details}>
          {merchant ? <Row label="Shop" value={data.merchantName} /> : null}
          <Row label="Paid with" value={METHOD_LABEL[data.method]} />
          {when ? <Row label="Date" value={when} /> : null}
          <Row label="Payment ID" value={<span className="mono" title={data.paymentId}>{shortId(data.paymentId)}</span>} />
          {data.explorerUrl ? (
            <Row
              label="Settled on XRPL"
              value={
                <a className={styles.link} href={data.explorerUrl} target="_blank" rel="noopener noreferrer">
                  View on XRPL <span className="mono">{data.settleTxHash ? shortHash(data.settleTxHash) : ""}</span> ↗
                </a>
              }
            />
          ) : pending ? (
            <Row label="Settled on XRPL" value={<span className="muted">Pending…</span>} />
          ) : null}
        </dl>
      </Card>

      {merchant && (data.status === "settled" || partial) ? (
        <p className={`muted ${styles.hint}`}>To refund, text Rove &lsquo;refund this&rsquo;.</p>
      ) : null}

      {!pending && !failed ? <SaveReceiptButton className={styles.noPrint} /> : null}

      <footer className={styles.footer}>
        <span>Powered by Rove</span>
        {demo ? <span className={styles.noPrint}> · demo data</span> : null}
      </footer>
    </main>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: ReceiptData["status"] }) {
  if (PENDING.includes(status)) {
    return (
      <span className={`${styles.pill} ${styles.pending}`} role="status">
        <span className={styles.dot} aria-hidden="true" />
        Settling…
      </span>
    );
  }
  const map = {
    settled: ["Paid ✓", styles.paid],
    partially_refunded: ["Paid · partly refunded", styles.neutral],
    refunded: ["Refunded", styles.neutral],
    failed: ["Failed", styles.failed],
  } as const;
  const [label, cls] = map[status as keyof typeof map] ?? ["", ""];
  return <span className={`${styles.pill} ${cls}`}>{label}</span>;
}
