// /setup data model + pure helpers (client-safe). Owner: Sahith · Task: SH-B2
// Prices stay decimal strings end to end; validation goes through `money()` from @rove/shared, never floats.
import { isPositive, money, toMinor } from "@rove/shared";

/** What the page needs from GET /api/me (or the demo fixtures). */
export interface SetupData {
  name: string;
  category: string | null;
  menu: { id: string; name: string; price: string; active: boolean }[];
}

export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const ITEM_NAME_MAX = 60;
export const CATEGORY_MAX = 40;
export const MAX_ITEMS = 50;
/** S$100,000.00 in cents: a sanity cap so a stray paste doesn't become a price. */
const MAX_PRICE_MINOR = 10_000_000n;

export const CATEGORIES = [
  { value: "hawker", label: "Hawker food" },
  { value: "drinks", label: "Drinks" },
  { value: "groceries", label: "Groceries" },
  { value: "cafe", label: "Café" },
  { value: "other", label: "Other" },
] as const;

export type CategoryChoice = (typeof CATEGORIES)[number]["value"];

/** Map a stored category ("hawker", "Hawker food", "bakery", "Something else"…) onto a chip + custom text. */
export function categoryFromStored(stored: string | null): { choice: CategoryChoice | null; custom: string } {
  const s = (stored ?? "").trim();
  if (!s) return { choice: null, custom: "" };
  const lower = s.toLowerCase();
  if (lower === "café" || lower === "coffee") return { choice: "cafe", custom: "" };
  const hit = CATEGORIES.find((c) => c.value === lower || c.label.toLowerCase() === lower);
  if (hit) return { choice: hit.value, custom: "" };
  if (lower === "something else") return { choice: "other", custom: "" };
  return { choice: "other", custom: s };
}

/** The value sent as `UpdateShopReq.category`, or undefined when no chip is picked. */
export function categoryToStored(choice: CategoryChoice | null, custom: string): string | undefined {
  if (!choice) return undefined;
  if (choice === "other") return custom.trim().slice(0, CATEGORY_MAX) || "other";
  return choice;
}

export type PriceResult = { ok: true; amount: string } | { ok: false; error: string };

/** "5.5" → "5.50"; "S$ 6" → "6.00"; rejects 0, negatives, >2 dp and anything that isn't a plain decimal. */
export function parsePrice(raw: string): PriceResult {
  const s = raw.trim().replace(/^s?\$\s*/i, "");
  if (!s) return { ok: false, error: "Add a price" };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, error: "Use numbers only, like 5.50" };
  const norm = s.startsWith(".") ? `0${s}` : s.endsWith(".") ? s.slice(0, -1) : s;
  if (/\.\d{3,}$/.test(norm)) return { ok: false, error: "Up to 2 decimal places" };
  let m;
  try {
    m = money(norm, "SGD");
  } catch {
    return { ok: false, error: "Use numbers only, like 5.50" };
  }
  if (!isPositive(m)) return { ok: false, error: "Price must be more than S$0" };
  if (toMinor(m) > MAX_PRICE_MINOR) return { ok: false, error: "That price looks too high" };
  return { ok: true, amount: m.amount };
}

export function itemNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Add a name";
  if (n.length > ITEM_NAME_MAX) return `Keep it under ${ITEM_NAME_MAX} characters`;
  return null;
}

export function shopNameError(name: string): string | null {
  const n = name.trim();
  if (n.length < NAME_MIN) return "Shop name needs at least 2 characters";
  if (n.length > NAME_MAX) return `Keep it under ${NAME_MAX} characters`;
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TRAILING_PRICE = /^(.+?)\s*[-–—:=@]?\s*(?:s?\$)?\s*(\d*\.?\d+)\s*$/i;
const LEADING_PRICE = /^(?:s?\$)?\s*(\d*\.?\d+)\s+(.+)$/i;

/**
 * Quick add: "chicken rice 5.50, barley 1.50" → [{Chicken rice, 5.50}, {Barley, 1.50}].
 * Items split on commas, semicolons or new lines; the price may come last ("kopi 1.80", "kopi - $1.80") or first ("1.80 kopi").
 * Chunks we can't read come back in `bad` so the merchant can fix them.
 */
export function parseQuickAdd(text: string): { items: { name: string; price: string }[]; bad: string[] } {
  const items: { name: string; price: string }[] = [];
  const bad: string[] = [];
  for (const chunk of text.split(/[,;\n]+/)) {
    const c = chunk.trim().replace(/\s+/g, " ");
    if (!c) continue;
    let name: string | undefined;
    let rawPrice: string | undefined;
    const t = TRAILING_PRICE.exec(c);
    if (t) {
      name = t[1];
      rawPrice = t[2];
    } else {
      const l = LEADING_PRICE.exec(c);
      if (l) {
        rawPrice = l[1];
        name = l[2];
      }
    }
    const cleanName = (name ?? "").trim().replace(/[-–—:=@]+$/, "").trim();
    const price = rawPrice !== undefined ? parsePrice(rawPrice) : null;
    if (!cleanName || itemNameError(cleanName) || !price || !price.ok) {
      bad.push(c);
      continue;
    }
    items.push({ name: capitalize(cleanName), price: price.amount });
  }
  return { items, bad };
}
