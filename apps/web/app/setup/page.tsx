// Merchant: shop setup mini-app (name, category, menu editor). Opened from the setup card.
// Owner: Sahith · Task: SH-B2 · Spec: docs/specs/web-app.md, docs/specs/onboarding.md (step 4)
// Must work in Safari AND inside Messages (Spectrum iMessage App card). Mobile-first, no navigation.
import type { Metadata } from "next";
import { previewMetadata } from "../../lib/og/metadata";
import { CardFrame, CardTitle } from "../../components";
import { fullPageHref, isCardMode } from "../../lib/ui/card";
import { readSession } from "../../lib/ui/session";
import { fixtureSetup } from "./_fixtures";
import { Expired, SetupApp } from "./SetupApp";

export function generateMetadata(): Promise<Metadata> {
  return previewMetadata({
    title: "Set up your shop · Rove",
    description: "Edit your shop name, category and menu.",
    robots: { index: false, follow: false },
    // The session token is in the URL; don't leak it to anything this page links to.
    referrer: "no-referrer",
  });
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const { t } = sp;
  const card = isCardMode(sp);
  const token = (Array.isArray(t) ? t[0] : t) ?? "";
  const fixtures = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";

  let valid = false;
  try {
    valid = readSession(token, ["setup"]) !== null;
  } catch (err) {
    // TOKEN_SECRET missing. Fine in fixture mode; otherwise treat the link as unusable rather than crash in Messages.
    if (!fixtures) console.error("[setup] could not verify session:", err);
  }

  if (!valid && !fixtures) {
    return card ? (
      <CardFrame eyebrow="Shop setup">
        <CardTitle sub="Text Rove “edit my shop” for a new one.">This link expired.</CardTitle>
      </CardFrame>
    ) : (
      <Expired />
    );
  }

  return (
    <SetupApp t={valid ? token : ""} fixture={fixtures ? fixtureSetup() : null} cardHref={card ? fullPageHref("/setup", sp) : null} />
  );
}
