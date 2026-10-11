// Root layout. Owner: Sahith (SH-A1). Every page renders into one centered mobile column (.shell in globals.css).
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rove",
  description: "Your shop, invoices and payouts, all in a text thread.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
