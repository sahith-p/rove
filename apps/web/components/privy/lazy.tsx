"use client";
// Lazy entry for the crypto buttons. Privy + viem load in their own chunk after the page renders, so the Stripe
// buttons above are never held up. With no NEXT_PUBLIC_PRIVY_APP_ID this renders nothing.
import dynamic from "next/dynamic";
import { CryptoButtons } from "./CryptoButtons";
import { CRYPTO_ENABLED, type CryptoPayProps } from "./config";

const CryptoPayChunk = dynamic(() => import("./CryptoPay"), {
  ssr: false,
  loading: () => <CryptoButtons disabled />,
});

export function CryptoPayLazy(props: CryptoPayProps) {
  if (!CRYPTO_ENABLED) return null;
  return <CryptoPayChunk {...props} />;
}

export { CRYPTO_ENABLED, type CryptoCheckout, type CryptoHandlers, type CryptoMethod } from "./config";
