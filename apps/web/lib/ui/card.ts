// Card mode: pages rendered LIVE inside an iMessage App card (a small fixed-height webview) carry `card=1`.
// They render a compact, no-scroll layout (components/CardFrame) whose one button opens the full page in Safari.
// Client-safe: pure functions over the search params.

export type SearchRecord = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** true when the URL has `card=1`. */
export function isCardMode(sp: SearchRecord): boolean {
  return first(sp.card) === "1";
}

/** The same URL without `card` (keeps `t`, `state`, …): what the card's button opens in a new tab / Safari. */
export function fullPageHref(path: string, sp: SearchRecord): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "card" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}
