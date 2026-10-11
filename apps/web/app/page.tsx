// Landing. Owner: Sahith (SH-A1). One static page that explains Rove: hero, how it works, merchants, customers,
// the money path, safety, the stack, a footer. No dashboard, no nav, no client JS.
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  CreditCard,
  Globe,
  Lock,
  MessageCircle,
  Mic,
  QrCode,
  ReceiptText,
  Scale,
  ShieldCheck,
  Smartphone,
  ThumbsUp,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppleLogo, BnbMark, Button, IconTile, StatusPill, StatusStepper, Wordmark } from "../components";
import { MoneyPath } from "./_landing/MoneyPath";
import { PayMock } from "./_landing/PayMock";
import { Section } from "./_landing/Section";
import { Thread, type ThreadMessage } from "./_landing/Thread";
import styles from "./home.module.css";

const roveNumber = process.env.NEXT_PUBLIC_ROVE_NUMBER?.trim();
const ICON = { size: 18, strokeWidth: 1.75 } as const;

// Hero: the short version of running a shop by text.
const HERO_THREAD: ThreadMessage[] = [
  { from: "me", text: "invoice Maya 12.50 for lunch" },
  { from: "rove", text: "Sent. Maya pays with code", code: "K7Q2MX" },
  { from: "rove", text: "Maya paid S$12.50 ✓ Settled on XRPL." },
  { from: "me", text: "withdraw everything" },
];

// For merchants: invoice, code, balance, withdraw with a 👍.
const MERCHANT_THREAD: ThreadMessage[] = [
  { from: "me", text: "invoice Maya 2 chicken rice and a barley" },
  { from: "rove", text: "S$12.50 from your menu. Sent Maya a pay card." },
  { from: "me", text: "code for 6.50" },
  { from: "rove", text: "One-time code and QR for S$6.50:", code: "K7Q2MX" },
  { from: "rove", text: "Maya paid S$12.50 ✓ Settled as 12.50 XSGD." },
  { from: "me", text: "balance?" },
  { from: "rove", text: "S$84.20 available today, 9 sales." },
  { from: "me", text: "withdraw everything" },
  {
    from: "rove",
    text: "Withdraw S$84.20 to DBS ••4821? Tap 👍 to confirm.",
    reaction: "👍",
  },
  {
    from: "rove",
    text: "Withdrawal on its way",
    attachment: (
      <StatusStepper
        steps={[
          { label: "On XRPL", state: "done" },
          { label: "Sent to bank", state: "done" },
          { label: "In your bank", state: "current" },
        ]}
      />
    ),
  },
];

const STEPS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <MessageCircle {...ICON} />,
    title: "Text Rove",
    body: "Say what you need: an invoice, a QR for 6.50, your balance. Rove builds it from your menu and texts your customer a pay card.",
  },
  {
    icon: <Smartphone {...ICON} />,
    title: "Customer taps and pays",
    body: "The card opens a tiny pay page. Apple Pay or card in their own currency, or AUSD and USDT from a wallet.",
  },
  {
    icon: <ShieldCheck {...ICON} />,
    title: "Settled on XRPL",
    body: "One XRPL Payment lands in the merchant's local stablecoin. Withdraw to the bank or your own wallet with a 👍.",
  },
];

const MERCHANT_CAN: { icon: ReactNode; text: string }[] = [
  { icon: <MessageCircle {...ICON} />, text: "Onboard in the chat: shop name, category, menu" },
  { icon: <ReceiptText {...ICON} />, text: "Invoice a contact; totals come from your menu" },
  { icon: <QrCode {...ICON} />, text: "One-time codes and QRs, plus a fixed shop QR sticker" },
  { icon: <Wallet {...ICON} />, text: "Balance, today's sales, refunds and withdrawals" },
  { icon: <Mic {...ICON} />, text: "Send a voice note, get a voice answer" },
];

const CUSTOMER_POINTS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <AppleLogo size={18} />,
    title: "Apple Pay or card",
    body: "Stripe charges the payer in their own currency, so a US card pays in US$ with no card FX fee.",
  },
  {
    icon: <Wallet {...ICON} />,
    title: "Crypto, no gas",
    body: "AUSD gasless on Base Sepolia, or USDT from a BNB Chain wallet.",
  },
  {
    icon: <QrCode {...ICON} />,
    title: "Codes, QRs, or a text",
    body: "Scan a QR, type a code, or text “pay ahseng 6.50”. Every route opens the same page.",
  },
  {
    icon: <ReceiptText {...ICON} />,
    title: "Receipt in the thread",
    body: "No app, no account. The receipt lands in the same conversation.",
  },
];

const SAFETY: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <ThumbsUp {...ICON} />,
    title: "Humans confirm every money move",
    body: "The agent can only propose. A withdrawal or refund waits as a pending action until you tap 👍 (or reply YES on WhatsApp); then plain code executes it.",
  },
  {
    icon: <Lock {...ICON} />,
    title: "Bank numbers never go in chat",
    body: "Only the secure bank page collects them and only the payout partner keeps them. We store a beneficiary id and the last 4.",
  },
  {
    icon: <Scale {...ICON} />,
    title: "Ledger reconciled against XRPL",
    body: "Withdrawals hold funds first. Available plus held must equal the merchant's XSGD balance on chain.",
  },
  {
    icon: <BadgeCheck {...ICON} />,
    title: "Credit what was delivered",
    body: "Settlement reads meta.delivered_amount, never the Amount field, and prices come from the database, never the model.",
  },
];

const STACK: { icon: ReactNode; name: string; role: string }[] = [
  { icon: <Globe {...ICON} />, name: "Ripple XRPL", role: "Custodial XSGD balances, RLUSD hub AMM path payments, trust lines, Credentials" },
  { icon: <BnbMark size={18} />, name: "BNB Chain", role: "USDT pay-in from a wallet on BSC testnet" },
  { icon: <Wallet {...ICON} />, name: "Agora AUSD", role: "Gasless AUSD checkout on Base Sepolia" },
  { icon: <Mic {...ICON} />, name: "ElevenLabs", role: "Voice notes in and out" },
  { icon: <MessageCircle {...ICON} />, name: "Photon Spectrum", role: "iMessage and WhatsApp, iMessage App cards" },
  { icon: <Bot {...ICON} />, name: "Claude", role: "The brain: one agent for both sides of a payment" },
  { icon: <CreditCard {...ICON} />, name: "Stripe", role: "Apple Pay and card, charged in the payer's currency" },
];

function TextCta({ label = "Text Rove to open a shop" }: { label?: string }) {
  return roveNumber ? (
    <Button href={`sms:${roveNumber}`} fullWidth icon={<MessageCircle {...ICON} />}>
      {label}
    </Button>
  ) : (
    <p className={styles.soon}>Text us to open a shop. Our number is coming soon.</p>
  );
}

export default function Home() {
  return (
    <main className={styles.home}>
      <header className={styles.top}>
        <Wordmark size="lg" />
        <span className={styles.topNote}>XRPL testnet</span>
      </header>

      {/* ------------------------------------------------------------ hero */}
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroText}>
          <span className="eyebrow">A payments agent you text</span>
          <h1 id="hero-title" className={`twoTone ${styles.headline}`}>
            <span>Your shop, invoices and payouts.</span>
            <span>All in a text thread.</span>
          </h1>
          <p className={styles.heroLede}>
            Rove runs your shop over iMessage. Customers tap a card and pay with Apple Pay, card or crypto. The money
            settles on XRPL in your local stablecoin.
          </p>
          <div className={styles.heroCta}>
            <TextCta />
            <a className={styles.textLink} href="#how">
              See how it works <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </div>
        </div>
        <Thread messages={HERO_THREAD} className={styles.heroThread} />
      </section>

      {/* ------------------------------------------------------------ proof */}
      <dl className={styles.proof}>
        <div>
          <dt>S$12.50 invoice</dt>
          <dd>
            <span className={styles.proofBig}>12.50</span> XSGD delivered, exactly
          </dd>
        </div>
        <div>
          <dt>Card to merchant currency</dt>
          <dd>
            <span className={styles.proofBig}>1</span> XRPL Payment through the AMM
          </dd>
        </div>
        <div>
          <dt>Ledger vs XRPL</dt>
          <dd>
            <span className={styles.proofBig}>0.00</span> difference, reconciled
          </dd>
        </div>
      </dl>

      {/* ------------------------------------------------------------ how it works */}
      <Section id="how" eyebrow="How it works" title="Three steps, one thread." lede="No dashboard to learn and no app to install. The web is a few single-purpose pages that open from a message.">
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={styles.stepItem}>
              <div className={styles.stepHead}>
                <IconTile>{s.icon}</IconTile>
                <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
              </div>
              <h3 className={styles.itemTitle}>{s.title}</h3>
              <p className={styles.itemBody}>{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* ------------------------------------------------------------ merchants */}
      <Section
        id="merchants"
        eyebrow="For merchants"
        title="Run the shop by text."
        lede="Onboard, edit the menu, invoice, make codes and QRs, check the balance and withdraw. Rove answers in the same thread, with iMessage App cards you can tap."
        className={styles.split}
      >
        <div className={styles.splitBody}>
          <Thread messages={MERCHANT_THREAD} label="Rove" />
          <ul className={styles.list}>
            {MERCHANT_CAN.map((m) => (
              <li key={m.text}>
                <span className={styles.listIcon} aria-hidden="true">
                  {m.icon}
                </span>
                {m.text}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ------------------------------------------------------------ customers */}
      <Section
        id="customers"
        eyebrow="For customers"
        title="Tap the card. Pay your way."
        lede="A minimal pay page that opens right inside Messages. Nothing to download, nothing to sign up for."
        className={styles.split}
      >
        <div className={styles.splitBody}>
          <PayMock />
          <ul className={styles.points}>
            {CUSTOMER_POINTS.map((p) => (
              <li key={p.title}>
                <IconTile>{p.icon}</IconTile>
                <div>
                  <h3 className={styles.itemTitle}>{p.title}</h3>
                  <p className={styles.itemBody}>{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ------------------------------------------------------------ money path */}
      <Section
        id="money"
        eyebrow="The money path"
        title="Any rail in. Local stablecoin out."
        lede="Card networks and wallets are where customers' money is. XRPL holds the merchant's balance and does FX and settlement. The bank is where merchants spend."
      >
        <MoneyPath />
        <div className={styles.receipt}>
          <div className={styles.receiptHead}>
            <span className="eyebrow">Testnet run</span>
            <StatusPill tone="success">Reconciled</StatusPill>
          </div>
          <dl className={styles.receiptRows}>
            <div>
              <dt>Invoice</dt>
              <dd className="num">S$12.50</dd>
            </div>
            <div>
              <dt>meta.delivered_amount</dt>
              <dd className="mono">12.50 XSGD</dd>
            </div>
            <div>
              <dt>Ledger available + held</dt>
              <dd>Matches XRPL balance</dd>
            </div>
          </dl>
        </div>
      </Section>

      {/* ------------------------------------------------------------ safety */}
      <Section
        id="safety"
        eyebrow="Safety"
        title="The agent never moves money."
        lede="Claude reads and writes the chat. Money moves only after a person says yes, and only plain code moves it."
      >
        <ul className={styles.grid}>
          {SAFETY.map((s) => (
            <li key={s.title} className={styles.gridItem}>
              <IconTile>{s.icon}</IconTile>
              <h3 className={styles.itemTitle}>{s.title}</h3>
              <p className={styles.itemBody}>{s.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* ------------------------------------------------------------ stack */}
      <Section id="stack" eyebrow="Built with" title="Each chain does what it's best at.">
        <ul className={styles.stack}>
          {STACK.map((s) => (
            <li key={s.name}>
              <IconTile>{s.icon}</IconTile>
              <div>
                <div className={styles.stackName}>{s.name}</div>
                <div className={styles.itemBody}>{s.role}</div>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {/* ------------------------------------------------------------ closing cta */}
      <section className={styles.closing} aria-labelledby="closing-title">
        <h2 id="closing-title" className={`twoTone ${styles.closingTitle}`}>
          <span>Open a shop in one text.</span>
          <span>Say hi to Rove and you're live in minutes.</span>
        </h2>
        <div className={styles.closingCta}>
          <TextCta label="Text Rove" />
        </div>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <Wordmark size="md" />
          <p className={styles.itemBody}>A payments agent you text.</p>
        </div>
        <div className={styles.footerCols}>
          <div>
            <span className="eyebrow">Pay with</span>
            <ul>
              <li>Apple Pay · card</li>
              <li>AUSD on Base</li>
              <li>USDT on BNB Chain</li>
            </ul>
          </div>
          <div>
            <span className="eyebrow">Settles on</span>
            <ul>
              <li>XRPL · XSGD</li>
              <li>USD · RLUSD · EUR</li>
              <li>Bank or own wallet</li>
            </ul>
          </div>
        </div>
        <p className={styles.footerNote}>
          Demo on XRPL testnet and Stripe test mode. Bank payouts are simulated.
        </p>
      </footer>
    </main>
  );
}
