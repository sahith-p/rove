// Root layout. Owner: Sahith (SH-A1).
export const metadata = { title: "Rove" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
