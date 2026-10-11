// Root layout. Owner: Sahith (SH-A1). Every page renders into one centered mobile column (.shell in globals.css).
// Faculty Glyphic (display serif) + Geist (UI) + Geist Mono (codes) are self-hosted by next/font (no network request at runtime) and exposed as CSS variables.
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import localFont from "next/font/local";
import "./globals.css";

// Display serif (OFL, single Regular weight): hero headlines, section titles, the "Rove" wordmark.
const serif = localFont({
  src: "./fonts/FacultyGlyphic-Regular.woff2",
  weight: "400",
  style: "normal",
  display: "swap",
  variable: "--font-serif",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

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
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
