"use client";
// The payment buttons. The page only needs `onPay(method)`. Apple Pay / card start a card checkout, and the page then
// swaps these buttons for Stripe's sheet (components/stripe/ExpressPay: Express Checkout Element + card form, SH-A3).
// SH-A4: the crypto buttons (AUSD, BNB Chain wallet) load lazily under them (components/privy), only when `crypto` is
// given and NEXT_PUBLIC_PRIVY_APP_ID is set. Card mode (?card=1) never renders this component.
// Layout: [ Pay] full width (primary), [Card] (secondary), the Safari fallback, then "or pay with crypto".
import { useEffect, useState } from "react";
import { ArrowUpRight, CreditCard } from "lucide-react";
import { Button } from "../../../components/Button";
import { AppleLogo } from "../../../components/icons";
import { CryptoPayLazy, type CryptoHandlers } from "../../../components/privy/lazy";
import type { PayMethod } from "./_api";
import styles from "./pay.module.css";

export interface PayOptionsProps {
  onPay: (method: PayMethod) => void;
  /** The method whose checkout is in flight (its button spins, the others are disabled). */
  busy?: PayMethod | null;
  disabled?: boolean;
  /** Crypto lanes (AUSD + BNB Chain). Omitted → no crypto buttons. */
  crypto?: CryptoHandlers;
}

declare global {
  interface Window {
    ApplePaySession?: { canMakePayments(): boolean };
  }
}

export function PayOptions({ onPay, busy = null, disabled = false, crypto }: PayOptionsProps) {
  // Apple Pay may not be offered inside the Messages web view; offer Safari unless Apple Pay is clearly available.
  const [safariHref, setSafariHref] = useState<string | null>(null);
  const [applePayReady, setApplePayReady] = useState(false);

  useEffect(() => {
    setSafariHref(window.location.href);
    try {
      setApplePayReady(Boolean(window.ApplePaySession?.canMakePayments()));
    } catch {
      setApplePayReady(false);
    }
  }, []);

  const [cryptoBusy, setCryptoBusy] = useState(false);
  const locked = disabled || busy !== null || cryptoBusy;

  return (
    <div className={styles.payOptions}>
      <Button
        fullWidth
        onClick={() => onPay("apple_pay")}
        loading={busy === "apple_pay"}
        disabled={locked && busy !== "apple_pay"}
        className={styles.applePay}
        icon={<AppleLogo size={19} />}
        aria-label={busy === "apple_pay" ? undefined : "Pay with Apple Pay"}
      >
        {busy === "apple_pay" ? "Starting Apple Pay…" : "Pay"}
      </Button>
      <Button
        fullWidth
        variant="secondary"
        onClick={() => onPay("card")}
        loading={busy === "card"}
        disabled={locked && busy !== "card"}
        icon={<CreditCard size={18} strokeWidth={1.5} />}
        aria-label={busy === "card" ? undefined : "Pay with card"}
      >
        {busy === "card" ? "Starting…" : "Card"}
      </Button>
      {!applePayReady ? (
        <a className={styles.safari} href={safariHref ?? undefined} target="_blank" rel="noopener noreferrer">
          Open in Safari to pay with Apple Pay
          <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </a>
      ) : null}
      {crypto ? <CryptoPayLazy handlers={crypto} disabled={disabled || busy !== null} onBusyChange={setCryptoBusy} /> : null}
    </div>
  );
}
