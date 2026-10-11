// Customer: fixed shop QR. Menu picker or amount entry → same checkout as /pay
// Owner: Sahith · Task: SH-A5 · Spec: docs/specs/web-app.md, docs/specs/invoicing-and-qr.md §1 + §6
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
// The shop is loaded server-side (so the menu is in the HTML and the card preview has a title); paying is client-side.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleAlert, RotateCw, ShoppingBag } from "lucide-react";
import { Button, CardFrame, CardLink, CardTitle, StateBlock } from "../../../components";
import { fullPageHref, isCardMode, type SearchRecord } from "../../../lib/ui/card";
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

export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchRecord> }) {
  const [{ merchantId: raw }, sp] = await Promise.all([params, searchParams]);
  const card = isCardMode(sp);
  const merchantId = normalizeShopCode(raw);
  const res = await loadShop(merchantId);

  if (res.kind === "not_found") notFound();

  // Inside an iMessage App card: shop name + menu size + "Order & pay" → the full page in Safari.
  if (card) {
    const href = fullPageHref(`/m/${encodeURIComponent(merchantId)}`, sp);
    if (res.kind === "error") {
      return (
        <CardFrame eyebrow="Shop" action={<CardLink href={href}>Open shop</CardLink>}>
          <CardTitle>Couldn&apos;t load this shop</CardTitle>
        </CardFrame>
      );
    }
    return (
      <CardFrame
        demo={res.demo}
        label={res.shop.name}
        action={
          <CardLink href={href} icon={<ShoppingBag size={17} strokeWidth={1.5} />}>
            Order &amp; pay
          </CardLink>
        }
      >
        <CardTitle>{res.shop.name}</CardTitle>
      </CardFrame>
    );
  }

  if (res.kind === "error") {
    return (
      <main className={payStyles.page}>
        <StateBlock
          tone="error"
          icon={<CircleAlert size={22} strokeWidth={1.5} />}
          title="Couldn't load this shop"
          line="Check your connection and try again."
          facts={[["Shop", merchantId, true]]}
        />
        <Button fullWidth variant="secondary" href={`/m/${encodeURIComponent(merchantId)}`} icon={<RotateCw size={18} strokeWidth={1.75} />}>
          Try again
        </Button>
      </main>
    );
  }

  return <ShopClient key={res.shop.id} shop={res.shop} demo={res.demo} />;
}
