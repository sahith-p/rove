// Privy + crypto-lane config shared by the lazy wrapper (no Privy import) and the real flow.
// NEXT_PUBLIC_PRIVY_APP_ID is public and inlined at build time. Empty → the crypto buttons are hidden.
import type { CheckoutRes } from "@rove/shared";
import type { z } from "zod";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const CRYPTO_ENABLED = PRIVY_APP_ID.length > 0;

export type CryptoMethod = "ausd" | "bnb";
export type CryptoCheckout = z.infer<typeof CheckoutRes>;

/** What a page hands the crypto buttons. */
export interface CryptoHandlers {
  /** POST /api/checkout for a crypto method. null → it failed (the page shows why) or the page took over (demo mode). */
  start: (method: CryptoMethod) => Promise<CryptoCheckout | null>;
  /** The payer signed / sent: the page moves to its processing state and polls the payment. */
  submitted: (checkout: CryptoCheckout) => void;
}

export interface CryptoPayProps {
  handlers: CryptoHandlers;
  /** Another method is in flight (or the page is re-quoting). */
  disabled?: boolean;
  /** The crypto flow is busy: the page locks its other buttons. */
  onBusyChange?: (busy: boolean) => void;
}
