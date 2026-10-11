// Name matching for menu items, contacts and shops: case-insensitive exact → prefix → fuzzy (Levenshtein ≤ 2).
// No match → the caller returns the closest names so the model can ask "Did you mean …?".

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export type MatchResult<T> = { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none"; closest: T[] };

/** Singular/plural tolerant ("barleys" → "barley"). */
function variants(s: string): string[] {
  const n = normalize(s);
  return n.endsWith("s") ? [n, n.slice(0, -1)] : [n];
}

export function matchByName<T>(query: string, items: T[], nameOf: (t: T) => string): MatchResult<T> {
  const qs = variants(query);
  if (!qs[0]) return { kind: "none", closest: [] };
  const named = items.map((item) => ({ item, name: normalize(nameOf(item)) }));

  const exact = named.filter((n) => qs.includes(n.name));
  if (exact.length === 1) return { kind: "one", item: exact[0]!.item };
  if (exact.length > 1) return { kind: "many", items: exact.map((e) => e.item) };

  const prefix = named.filter((n) => qs.some((q) => n.name.startsWith(q) || q.startsWith(n.name)));
  if (prefix.length === 1) return { kind: "one", item: prefix[0]!.item };
  if (prefix.length > 1) {
    // "chicken rice" vs "roasted chicken rice": prefer the shortest name that starts with the query
    const starts = prefix.filter((n) => qs.some((q) => n.name.startsWith(q)));
    if (starts.length === 1) return { kind: "one", item: starts[0]!.item };
    return { kind: "many", items: prefix.map((p) => p.item) };
  }

  const scored = named
    .map((n) => ({ ...n, d: Math.min(...qs.map((q) => levenshtein(q, n.name))) }))
    .sort((a, b) => a.d - b.d);
  const fuzzy = scored.filter((s) => s.d <= 2);
  if (fuzzy.length === 1 || (fuzzy.length > 1 && fuzzy[0]!.d < fuzzy[1]!.d)) return { kind: "one", item: fuzzy[0]!.item };
  if (fuzzy.length > 1) return { kind: "many", items: fuzzy.map((f) => f.item) };

  const contains = named.filter((n) => qs.some((q) => n.name.includes(q)));
  if (contains.length === 1) return { kind: "one", item: contains[0]!.item };
  return { kind: "none", closest: (contains.length ? contains : scored.slice(0, 3)).map((s) => s.item) };
}

/** Digits → E.164. Bare 8-digit Singapore numbers get +65; 10-digit US numbers get +1. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 8 && /^[3689]/.test(digits)) return `+65${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}
