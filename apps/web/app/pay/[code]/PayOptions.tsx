"use client";
// The payment buttons. SH-A3 swaps the Apple Pay placeholder for Stripe's Express Checkout Element and wires card;
// SH-A4 wires the BNB Chain wallet. The page only needs `onPay(method)`.
import { useEffect, useState } from "react";
import { Button } from "../../../components";
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
      >
        {busy === "apple_pay" ? "Starting Apple Pay…" : "Pay with Apple Pay"}
      </Button>
      <Button
        fullWidth
        variant="secondary"
        onClick={() => onPay("card")}
        loading={busy === "card"}
        disabled={locked && busy !== "card"}
      >
        {busy === "card" ? "Starting…" : "Pay with card"}
      </Button>
      <button
        type="button"
        className={styles.tertiary}
        onClick={() => onPay("bnb")}
        disabled={locked}
        aria-busy={busy === "bnb" || undefined}
      >
        {busy === "bnb" ? "Connecting wallet…" : "Pay with a BNB Chain wallet"}
      </button>
      {!applePayReady ? (
        <a className={styles.safari} href={safariHref ?? undefined} target="_blank" rel="noopener noreferrer">
          Open in Safari to pay with Apple Pay ↗
        </a>
      ) : null}
    </div>
  );
}
