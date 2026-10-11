// SERVER ONLY. Preview metadata for the card pages (SH-B3): title + description mirrored into Open Graph / Twitter,
// and metadataBase from the request so the opengraph-image URL is absolute on whichever host served the card.
import type { Metadata } from "next";
import { metadataBase } from "./origin";

export async function previewMetadata(
  m: { title: string; description: string } & Pick<Metadata, "robots" | "referrer">,
): Promise<Metadata> {
  const { title, description, ...rest } = m;
  return {
    metadataBase: await metadataBase(),
    title,
    description,
    ...rest,
    openGraph: { title, description, siteName: "Rove", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}
