// SERVER ONLY (Node runtime). Faculty Glyphic (display serif) + Geist + Geist Mono for the OG images, read from packages/imessage-apps/assets/fonts.
// cwd is apps/web under `next dev/build` and on Vercel, but the repo root when something runs from there, so check both.
// Any missing file is skipped; with no fonts at all, next/og falls back to its bundled default font.
import { readFile } from "node:fs/promises";
import path from "node:path";

type Weight = 400 | 500 | 600 | 700;
export interface OgFont {
  name: "Geist" | "Geist Mono" | "Faculty Glyphic";
  data: ArrayBuffer;
  weight: Weight;
  style: "normal";
}

const FILES: { file: string; name: OgFont["name"]; weight: Weight }[] = [
  { file: "Geist-Regular.ttf", name: "Geist", weight: 400 },
  { file: "Geist-SemiBold.ttf", name: "Geist", weight: 600 },
  { file: "Geist-Bold.ttf", name: "Geist", weight: 700 },
  { file: "GeistMono-Medium.ttf", name: "Geist Mono", weight: 500 },
  { file: "GeistMono-SemiBold.ttf", name: "Geist Mono", weight: 600 },
  { file: "FacultyGlyphic-Regular.ttf", name: "Faculty Glyphic", weight: 400 },
];

function fontDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, "..", "..", "packages", "imessage-apps", "assets", "fonts"), // cwd = apps/web (next dev/build, Vercel)
    path.join(cwd, "packages", "imessage-apps", "assets", "fonts"), // cwd = repo root
  ];
}

async function readFirst(file: string): Promise<ArrayBuffer | null> {
  for (const dir of fontDirs()) {
    try {
      const buf = await readFile(path.join(dir, file));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      // try the next location
    }
  }
  return null;
}

let cached: Promise<OgFont[]> | null = null;

/** The fonts that could be read (possibly none). Cached for the life of the server process. */
export function ogFonts(): Promise<OgFont[]> {
  cached ??= Promise.all(
    FILES.map(async ({ file, name, weight }) => {
      const data = await readFirst(file);
      return data ? ({ name, data, weight, style: "normal" } satisfies OgFont) : null;
    }),
  ).then((list) => {
    const fonts = list.filter((f): f is OgFont => f !== null);
    if (fonts.length < FILES.length) {
      console.warn(`[og] loaded ${fonts.length}/${FILES.length} fonts; the rest fall back to the default font`);
    }
    if (fonts.length === 0) cached = null; // try again on the next image instead of caching the miss forever
    return fonts;
  });
  return cached;
}
