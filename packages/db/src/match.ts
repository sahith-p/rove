// Name matching for menu items, contacts and shops, in TypeScript (no Postgres extensions needed).
// Tiers, first non-empty tier wins: exact → prefix → word prefix ("egg" → "Add egg") → fuzzy (Levenshtein ≤ 2).
// One hit in a tier is a confident match. Several hits are ambiguous (fuzzy: the unique closest still wins), and the
// caller gets them back so the agent can ask. No hit at all → the closest names as suggestions.

/** Case-, accent- and punctuation-insensitive form: "Ah Seng's  Chicken-Rice" → "ah sengs chicken rice". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Levenshtein distance over code points. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length]!;
}

/** Edits allowed for a confident fuzzy match: 2, but 1 for 3–4 character queries and none below (too risky). */
export function fuzzyBudget(len: number): number {
  return len >= 5 ? 2 : len >= 3 ? 1 : 0;
}

export interface NameMatch<T> {
  /** Confident single match. */
  match: T | null;
  /** Several equally plausible matches (ambiguous). Empty when `match` is set or nothing matched. */
  ambiguous: T[];
  /** Closest items when there is no confident match (ambiguous ones first), at most `limit`. */
  suggestions: T[];
}

interface Scored<T> {
  item: T;
  name: string;
  tier: number; // 0 exact, 1 prefix, 2 word prefix, 3 fuzzy, 4 none
  dist: number; // Levenshtein to the full name
  close: number; // closeness for suggestions: min(distance to full name, distance to the name's same-length prefix)
}

export function matchName<T>(query: string, items: readonly T[], nameOf: (t: T) => string, limit = 3): NameMatch<T> {
  const q = normalizeName(query);
  if (!q || !items.length) return { match: null, ambiguous: [], suggestions: [] };
  const qLen = Array.from(q).length;
  const budget = fuzzyBudget(qLen);

  const scored: Scored<T>[] = items.map((item) => {
    const name = normalizeName(nameOf(item));
    const dist = levenshtein(q, name);
    const prefixDist = levenshtein(q, Array.from(name).slice(0, qLen).join(""));
    const tier =
      name === q ? 0 : name.startsWith(q) ? 1 : ` ${name}`.includes(` ${q}`) ? 2 : dist <= budget ? 3 : 4;
    return { item, name, tier, dist, close: Math.min(dist, prefixDist) };
  });
  const byCloseness = (a: Scored<T>, b: Scored<T>) => a.tier - b.tier || a.close - b.close || a.dist - b.dist || a.name.localeCompare(b.name);

  for (let tier = 0; tier <= 3; tier++) {
    const hits = scored.filter((s) => s.tier === tier).sort(byCloseness);
    if (!hits.length) continue;
    if (hits.length === 1) return { match: hits[0]!.item, ambiguous: [], suggestions: [] };
    if (tier === 3 && hits[0]!.dist < hits[1]!.dist) return { match: hits[0]!.item, ambiguous: [], suggestions: [] };
    const ambiguous = hits.map((h) => h.item);
    return { match: null, ambiguous, suggestions: ambiguous.slice(0, limit) };
  }

  // Nothing matched: suggest names that are at least loosely close (typo'd prefix, a word or two off).
  const loose = Math.max(2, Math.floor(qLen * 0.4));
  const suggestions = scored
    .filter((s) => s.close <= loose)
    .sort(byCloseness)
    .slice(0, limit)
    .map((s) => s.item);
  return { match: null, ambiguous: [], suggestions };
}
