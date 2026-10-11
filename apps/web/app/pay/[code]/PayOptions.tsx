"use client";
// The payment buttons. SH-A3 swaps the Apple Pay placeholder for Stripe's Express Checkout Element and wires card;
// SH-A4 wires the BNB Chain wallet. The page only needs `onPay(method)`.
// Layout: [ Pay] full width (primary), then [Card] [BNB Chain] side by side (secondary), then the Safari fallback.
import { useEffect, useState } from "react";
import { ArrowUpRight, CreditCard } from "lucide-react";
import { Button } from "../../../components/Button";
import { AppleLogo, BnbMark } from "../../../components/icons";
import type { PayMethod } from "./_api";
import styles from "./pay.module.css";

export interface PayOptionsProps {
  onPay: (method: PayMethod) => void;
  /** The method whose checkout is in flight (its button spins, the others are disabled). */
  busy?: PayMethod | null;
  disabled?: boolean;
}

declare global {
  interface Window {
    ApplePaySession?: { canMakePayments(): boolean };
  }
}

export function PayOptions({ onPay, busy = null, disabled = false }: PayOptionsProps) {
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

  const locked = disabled || busy !== null;

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
      <div className={styles.altMethods}>
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
        <Button
          fullWidth
          variant="secondary"
          onClick={() => onPay("bnb")}
          loading={busy === "bnb"}
          disabled={locked && busy !== "bnb"}
          icon={<BnbMark size={18} />}
          aria-label={busy === "bnb" ? undefined : "Pay with a BNB Chain wallet"}
        >
          {busy === "bnb" ? "Connecting…" : "BNB Chain"}
        </Button>
      </div>
      {!applePayReady ? (
        <a className={styles.safari} href={safariHref ?? undefined} target="_blank" rel="noopener noreferrer">
          Open in Safari to pay with Apple Pay
          <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
