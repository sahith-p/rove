"use client";
// PrivyProvider for the pay pages (SH-A4): email login → embedded EVM wallet, or an injected wallet (MetaMask etc.).
// Chains: Base Sepolia (AUSD lane) + BSC testnet (USDT lane). Only mounted by CryptoPay, which is loaded lazily.
import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { baseSepolia, bscTestnet } from "viem/chains";
import { PRIVY_APP_ID } from "./config";

export function RovePrivyProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          theme: "light",
          accentColor: "#0a0a0a",
          landingHeader: "Pay with a wallet",
          walletList: ["detected_wallets", "metamask", "coinbase_wallet", "rainbow", "wallet_connect"],
        },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        supportedChains: [baseSepolia, bscTestnet],
        defaultChain: baseSepolia,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
