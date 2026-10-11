// Merchant: minimal 'my shop' page: balance, recent payments, open invoices, withdrawals, menu, contacts.
// Owner: Sahith · Task: SH-C3 · Spec: docs/specs/web-app.md, docs/specs/withdrawals.md §1
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation, read-only:
// every change happens by texting Rove. Re-renders silently every 10s (AutoRefresh → router.refresh()).
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { MeRes, isPositive } from "@rove/shared";
import { ChevronRight, Clock, Landmark, MessageSquare, QrCode, ReceiptText, Send, ShieldCheck, Store, Wallet } from "lucide-react";
import {
  Amount,
  CardAmount,
  CardFrame,
  CardLink,
  CardTitle,
  IconTile,
  Notice,
  PageFooter,
  Row,
  Rows,
} from "../../components";
import { fullPageHref, isCardMode } from "../../lib/ui/card";
import { previewMetadata } from "../../lib/og/metadata";
import { format, relativeTime } from "../../lib/ui/format";
import { readSession, sessionHeaders } from "../../lib/ui/session";
import { AutoRefresh } from "./_AutoRefresh";
import { shopFixture, type MeData } from "./_fixtures";
import { PAYMENT_STATUS, SOURCE_LABEL, WITHDRAWAL_STATUS, categoryLabel, maskPhone, type Tone } from "./_labels";
import styles from "./shop.module.css";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return previewMetadata({
    title: "My shop · Rove",
    description: "Your balance, recent payments, open invoices and payouts.",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  });
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FIXTURES = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

interface Loaded {
  data: MeData;
  /** true/false when the API reports reconciliation; null when unknown (then the line is hidden). */
  reconciled: boolean | null;
}

async function loadMe(token: string): Promise<Loaded | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    const res = await fetch(`${proto}://${host}/api/me`, { headers: sessionHeaders(token), cache: "no-store" });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    const data = MeRes.parse(raw);
    const flag = raw && typeof raw === "object" ? (raw as { reconciled?: unknown }).reconciled : undefined;
    return { data, reconciled: typeof flag === "boolean" ? flag : null };
  } catch {
    return null;
  }
}

function withT(path: string, t: string | undefined): string {
  if (!t) return path;
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}`;
}

const SOURCE_ICON: Record<MeData["recentPayments"][number]["source"], ReactNode> = {
  invoice: <ReceiptText size={16} strokeWidth={1.5} />,
  one_time_qr: <QrCode size={16} strokeWidth={1.5} />,
  fixed_qr: <Store size={16} strokeWidth={1.5} />,
  pay_request: <Send size={16} strokeWidth={1.5} />,
};

/** Status as a meaning-colored dot + label, no fill. */
function Status({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={styles.status} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {children}
    </span>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className="eyebrow">{title}</h2>
        {aside ? <span className={`eyebrow ${styles.aside}`}>{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <p className={styles.empty}>{children}</p>;
}

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const t = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const card = isCardMode(sp);

  let session: ReturnType<typeof readSession> = null;
  try {
    session = readSession(t, ["shop"]);
  } catch (err) {
    if (!FIXTURES) throw err; // TOKEN_SECRET missing outside demo mode is a misconfiguration, not an expired link
  }

  if (!session && !FIXTURES) {
    if (card) {
      return (
        <CardFrame eyebrow="My shop">
          <CardTitle sub="Text Rove ‘my shop’ for a new one.">This link expired.</CardTitle>
        </CardFrame>
      );
    }
    return (
      <main className={styles.page}>
        <Notice title="This link expired.">Text Rove &lsquo;my shop&rsquo; for a new one.</Notice>
      </main>
    );
  }

  const token = session && t ? t : undefined;
  let loaded = token ? await loadMe(token) : null;
  if (!loaded && FIXTURES) loaded = { data: shopFixture(), reconciled: true };

  if (!loaded) {
    if (card) {
      return (
        <CardFrame eyebrow="My shop" action={<CardLink href={fullPageHref("/shop", sp)}>Open my shop</CardLink>}>
          <AutoRefresh ms={10_000} />
          <CardTitle>Couldn&rsquo;t load your shop.</CardTitle>
        </CardFrame>
      );
    }
    return (
      <main className={styles.page}>
        <AutoRefresh ms={10_000} />
        <Notice variant="error" title="Couldn't load your shop.">
          We&rsquo;ll keep trying. You can also text Rove &lsquo;my shop&rsquo;.
        </Notice>
      </main>
    );
  }

  const { data, reconciled } = loaded;
  const { merchant, balance } = data;
  const category = categoryLabel(merchant.category);
  const payments = data.recentPayments.slice(0, 10);
  const now = Date.now();

  if (card) {
    return (
      <CardFrame
        eyebrow={<span>{merchant.name}</span>}
        demo={FIXTURES && !token}
        action={
          <CardLink href={fullPageHref("/shop", sp)} icon={<Store size={18} strokeWidth={1.5} />}>
            Open my shop
          </CardLink>
        }
      >
        <AutoRefresh ms={10_000} />
        <CardAmount money={balance.available} />
      </CardFrame>
    );
  }

  return (
    <main className={styles.page}>
      <AutoRefresh ms={10_000} />

      {/* 1 · Header: two-tone (ink name, muted meta) */}
      <header className={styles.header}>
        <span className="eyebrow">My shop</span>
        <h1 className={styles.name}>{merchant.name}</h1>
        <div className={styles.meta}>
          {merchant.verified ? (
            <span className={styles.badge}>
              <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
              Verified on XRPL
            </span>
          ) : null}
          {category ? <span>{category}</span> : null}
          {merchant.status === "draft" ? <span>Draft</span> : null}
        </div>
      </header>

      {/* 2 · Balance: the hero, then hairline rows */}
      <section className={styles.balance}>
        <Amount label="Available" money={balance.available} />
        <Rows>
          {isPositive(balance.held) ? <Row label="In withdrawals" value={format(balance.held)} /> : null}
          {reconciled === true ? (
            <Row label="Ledger" value="Matches XRPL" tone="success" icon={<ShieldCheck size={15} strokeWidth={1.75} />} />
          ) : reconciled === false ? (
            <Row label="Ledger" value="Reconciling with XRPL…" tone="muted" />
          ) : null}
          {merchant.autoWithdraw === "daily" ? (
            <Row label="Auto-withdraw" value="Daily at 9pm" icon={<Clock size={15} strokeWidth={1.5} />} />
          ) : null}
        </Rows>
      </section>

      {/* 3 · Hints (non-interactive) */}
      <div className={styles.hints} aria-label="Things you can text Rove">
        <span className={styles.hintLead}>
          <MessageSquare size={14} strokeWidth={1.5} aria-hidden="true" />
          Text Rove
        </span>
        <span className={styles.chip}>withdraw everything</span>
        <span className={styles.chip}>invoice Maya 10</span>
        <span className={styles.chip}>QR for 6.50</span>
      </div>

      {/* 4 · Recent payments */}
      <Section title="Recent payments" aside={payments.length ? `Last ${payments.length}` : undefined}>
        {payments.length ? (
          <ul className={styles.list}>
            {payments.map((p) => {
              const st = PAYMENT_STATUS[p.status];
              return (
                <li key={p.id}>
                  <a className={styles.row} href={withT(`/r/${encodeURIComponent(p.id)}?view=merchant`, token)}>
                    <IconTile>{SOURCE_ICON[p.source]}</IconTile>
                    <div className={styles.main}>
                      <div className={styles.title}>{SOURCE_LABEL[p.source]}</div>
                      <div className={styles.sub}>{relativeTime(p.createdAt, now)}</div>
                    </div>
                    <div className={styles.end}>
                      <div className={styles.money}>{format(p.local)}</div>
                      <Status tone={st.tone}>{st.label}</Status>
                    </div>
                    <ChevronRight size={16} strokeWidth={1.5} className={styles.chev} aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No payments yet. Text Rove &lsquo;QR for 6.50&rsquo; to take your first.</Empty>
        )}
      </Section>

      {/* 5 · Open invoices */}
      <Section title="Open invoices" aside={data.openInvoices.length ? String(data.openInvoices.length) : undefined}>
        {data.openInvoices.length ? (
          <ul className={styles.list}>
            {data.openInvoices.map((inv) => (
              <li key={inv.code} className={styles.row}>
                <span className={styles.code}>{inv.code}</span>
                <div className={styles.main}>
                  <div className={styles.title}>
                    {inv.to ? (inv.to.startsWith("+") ? maskPhone(inv.to) : inv.to) : "Anyone with the code"}
                  </div>
                  <div className={styles.sub}>Sent {relativeTime(inv.createdAt, now)}</div>
                </div>
                <div className={styles.end}>
                  <div className={styles.money}>{format(inv.total)}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing outstanding.</Empty>
        )}
      </Section>

      {/* 6 · Withdrawals */}
      <Section title="Withdrawals">
        {data.withdrawals.length ? (
          <ul className={styles.list}>
            {data.withdrawals.map((w) => {
              const st = WITHDRAWAL_STATUS[w.status];
              return (
                <li key={w.id}>
                  <a className={styles.row} href={withT(`/w/${encodeURIComponent(w.id)}`, token)}>
                    <IconTile>
                      {w.destination.kind === "bank" ? <Landmark size={16} strokeWidth={1.5} /> : <Wallet size={16} strokeWidth={1.5} />}
                    </IconTile>
                    <div className={styles.main}>
                      <div className={styles.title}>
                        {w.destination.kind === "bank" ? "To " : "To wallet "}
                        {w.destination.label}
                      </div>
                      <div className={styles.sub}>{relativeTime(w.updatedAt, now)}</div>
                    </div>
                    <div className={styles.end}>
                      <div className={styles.money}>{format(w.amount)}</div>
                      <Status tone={st.tone}>{st.label}</Status>
                    </div>
                    <ChevronRight size={16} strokeWidth={1.5} className={styles.chev} aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No withdrawals yet.</Empty>
        )}
      </Section>

      {/* 7 · Menu */}
      <Section title="Menu" aside={data.menu.length ? String(data.menu.length) : undefined}>
        {data.menu.length ? (
          <ul className={styles.list}>
            {data.menu.map((m) => (
              <li key={m.id} className={`${styles.row} ${styles.compact} ${m.active ? "" : styles.inactive}`}>
                <div className={styles.main}>
                  <div className={styles.title}>
                    {m.name}
                    {m.active ? null : <span className={styles.off}> · hidden</span>}
                  </div>
                </div>
                <div className={styles.money}>{format(m.price)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No menu yet.</Empty>
        )}
        <p className={styles.footnote}>To edit, text Rove &lsquo;edit my shop&rsquo;.</p>
      </Section>

      {/* 8 · Contacts */}
      <Section title="Contacts" aside={data.contacts.length ? String(data.contacts.length) : undefined}>
        {data.contacts.length ? (
          <ul className={styles.list}>
            {data.contacts.map((c) => (
              <li key={c.id} className={`${styles.row} ${styles.compact}`}>
                <span className={styles.initial} aria-hidden="true">
                  {Array.from(c.name.trim())[0]?.toUpperCase() ?? "?"}
                </span>
                <div className={styles.main}>
                  <div className={styles.title}>{c.name}</div>
                </div>
                <div className={styles.phone}>{maskPhone(c.phone)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No contacts yet. Text Rove &lsquo;add Maya +65 9123 4567&rsquo;.</Empty>
        )}
      </Section>

      <PageFooter demo={FIXTURES && !token}>Read-only · change things by text</PageFooter>
    </main>
  );
}
