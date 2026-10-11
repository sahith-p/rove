// The money path, top to bottom on phones and left to right on desktop:
// card / crypto → treasury RLUSD → one XRPL Payment through the AMM → merchant XSGD → bank or wallet.
import { ArrowDown, ArrowRightLeft, Coins, CreditCard, Landmark, Store } from "lucide-react";
import type { ReactNode } from "react";
import { IconTile } from "../../components";
import styles from "./landing.module.css";

const NODES: { icon: ReactNode; step: string; title: string; body: string; tags: string[] }[] = [
  {
    icon: <CreditCard size={18} strokeWidth={1.75} />,
    step: "In",
    title: "Customer pays",
    body: "Apple Pay or card through Stripe, charged in the payer's own currency. Or crypto from a wallet.",
    tags: ["Apple Pay", "Card", "AUSD · Base", "USDT · BNB"],
  },
  {
    icon: <Coins size={18} strokeWidth={1.75} />,
    step: "Float",
    title: "Treasury on XRPL",
    body: "Rove's treasury float holds the payer's side as RLUSD (or XSGD for SGD payers).",
    tags: ["RLUSD", "Treasury"],
  },
  {
    icon: <ArrowRightLeft size={18} strokeWidth={1.75} />,
    step: "Swap",
    title: "One XRPL Payment",
    body: "A single cross-currency Payment routes RLUSD to XSGD through the RLUSD hub AMM at market rate.",
    tags: ["AMM", "Path payment"],
  },
  {
    icon: <Store size={18} strokeWidth={1.75} />,
    step: "Settle",
    title: "Merchant balance",
    body: "We credit exactly what meta.delivered_amount says into the merchant's own custodial XRPL account.",
    tags: ["XSGD", "USD", "EUR", "Credentials"],
  },
  {
    icon: <Landmark size={18} strokeWidth={1.75} />,
    step: "Out",
    title: "Bank or wallet",
    body: "After a 👍, XSGD is redeemed to the bank (StraitsX payout, simulated) or sent to the merchant's XRPL wallet.",
    tags: ["PayNow / FAST", "Self-custody"],
  },
];

export function MoneyPath() {
  return (
    <ol className={styles.path}>
      {NODES.map((n, i) => (
        <li key={n.title} className={styles.pathNode}>
          <div className={styles.pathCard}>
            <div className={styles.pathHead}>
              <IconTile>{n.icon}</IconTile>
              <span className="eyebrow">
                {String(i + 1).padStart(2, "0")} · {n.step}
              </span>
            </div>
            <h3 className={styles.pathTitle}>{n.title}</h3>
            <p className={styles.pathBody}>{n.body}</p>
            <div className={styles.tags}>
              {n.tags.map((t) => (
                <span key={t} className={styles.tag}>
                  {t}
                </span>
              ))}
            </div>
          </div>
          {i < NODES.length - 1 ? (
            <span className={styles.pathArrow} aria-hidden="true">
              <ArrowDown size={16} strokeWidth={1.75} />
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
