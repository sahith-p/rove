// Customer: fixed shop QR. Menu picker or amount entry → same checkout as /pay
// Owner: Sahith · Task: SH-A5 · Spec: docs/specs/web-app.md, docs/specs/invoicing-and-qr.md §1 + §6
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// The shop is loaded server-side (so the menu is in the HTML and the card preview has a title); paying is client-side.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "../../../components";
import payStyles from "../../pay/[code]/pay.module.css";
import { loadShop, normalizeShopCode } from "./_data";
import { ShopClient } from "./ShopClient";

export const dynamic = "force-dynamic";

type Params = Promise<{ merchantId: string }>;

const DESCRIPTION = "Pick from the menu or type an amount. Pay with Apple Pay, card, or a BNB Chain wallet. Settles on XRPL.";

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { merchantId } = await params;
  const res = await loadShop(normalizeShopCode(merchantId));
  if (res.kind !== "ok") return { title: "Pay with Rove", description: DESCRIPTION };
  const title = `${res.shop.name} · Pay with Rove`;
  return { title, description: DESCRIPTION, openGraph: { title, description: DESCRIPTION } };
}

export default async function Page({ params }: { params: Params }) {
  const { merchantId: raw } = await params;
  const merchantId = normalizeShopCode(raw);
  const res = await loadShop(merchantId);

  if (res.kind === "not_found") notFound();

  if (res.kind === "error") {
    return (
      <main className={payStyles.page}>
        <section className={payStyles.state} data-tone="error">
          <div className={payStyles.stateIcon} aria-hidden="true">
            !
          </div>
          <h1 className={payStyles.stateTitle}>Couldn&apos;t load this shop</h1>
          <p className={payStyles.stateLine}>Check your connection and try again.</p>
          <p className={payStyles.codeLine}>Shop {merchantId}</p>
        </section>
        <Button fullWidth variant="secondary" href={`/m/${encodeURIComponent(merchantId)}`}>
          Try again
        </Button>
      </main>
    );
  }

  return <ShopClient key={res.shop.id} shop={res.shop} demo={res.demo} />;
}
