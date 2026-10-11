// Currency-aware wording. Every name, symbol and country comes from the shared registry (packages/shared/src/currencies.ts),
// so a shop paid in EUR or USD reads as naturally as one paid in SGD. Amounts themselves are always format(money).

import { allCurrencies, currencyForPhone, currencyInfo, format, isMerchantCurrency, money, type Currency } from "@rove/shared";

/** Default for shops whose phone country has no enabled currency (the demo is Singapore). */
export const DEFAULT_SHOP_CURRENCY: Currency = "SGD";

/** "Singapore dollars", "euros", "US dollars", "Brazilian reais": the plural, as said in a sentence. */
export function currencyPlural(code: string): string {
  const info = allCurrencies().find((c) => c.code === code);
  const name = info?.name ?? code;
  if (/real$/i.test(name)) return name.replace(/real$/i, "reais");
  const lower = /^(euro|rupee)$/i.test(name) ? name.toLowerCase() : name;
  return lower.endsWith("s") ? lower : `${lower}s`;
}

/** "Singapore dollars (S$)" */
export function currencyLabel(code: Currency): string {
  return `${currencyPlural(code)} (${currencyInfo(code).symbol})`;
}

/** An example amount in this currency for prompts, e.g. "S$12.50", "€12.50". */
export function exampleAmount(code: Currency, amount = "12.50"): string {
  return format(money(amount, code));
}

/** "Singapore", "Germany": the country's English name; falls back to the code. */
export function countryName(cc: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

/** The currency a new shop on this phone gets paid in: the phone country's currency if Rove supports it, else SGD. */
export function shopCurrencyForPhone(phone: string): Currency {
  // Demo override: SHOP_CURRENCY=SGD makes every new shop an XSGD shop, whatever the phone's country (our demo
  // phones are +1, which would otherwise give USD shops).
  const forced = process.env.SHOP_CURRENCY?.trim().toUpperCase();
  if (isMerchantCurrency(forced)) return forced;
  const code = currencyForPhone(phone)?.code;
  return isMerchantCurrency(code) ? code : DEFAULT_SHOP_CURRENCY;
}

/** The country to record for a new shop: the phone's country when it uses the shop's currency, else the currency's first. */
export function shopCountryForPhone(phone: string, currency: Currency): string {
  const info = currencyInfo(currency);
  const byPhone = currencyForPhone(phone);
  return byPhone?.code === currency ? (byPhone.countries[0] ?? info.countries[0] ?? "SG") : (info.countries[0] ?? "SG");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spoken unit for an amount: "dollars" for a shop's own dollar, otherwise the full plural ("euros", "US dollars"). */
function spokenUnit(code: string, whole: string, local: string | undefined): string {
  const plural = code === local && /dollars$/.test(currencyPlural(code)) ? "dollars" : currencyPlural(code);
  return whole === "1" ? plural.replace(/(s|is)$/, (m) => (m === "is" ? "l" : "")) : plural;
}

/**
 * Amounts as speech for voice replies: "S$12.50" → "12 dollars 50" (in an SGD shop), "€4.20" → "4 euros 20",
 * "US$3.00" → "3 US dollars". Works for every currency in the registry.
 */
export function speakAmounts(text: string, localCurrency?: string): string {
  const symbols = [...allCurrencies()].sort((a, b) => b.symbol.length - a.symbol.length);
  const re = new RegExp(`(${symbols.map((c) => escapeRe(c.symbol)).join("|")})\\s?(\\d[\\d,]*)(?:\\.(\\d{1,2}))?`, "g");
  // Without a shop currency, the first amount's currency is the local one (a shop mostly talks in its own money).
  const firstSymbol = new RegExp(re.source).exec(text)?.[1];
  localCurrency ??= symbols.find((c) => c.symbol === firstSymbol)?.code;
  return text.replace(re, (_m, symbol: string, whole: string, cents?: string) => {
    const code = symbols.find((c) => c.symbol === symbol)?.code ?? "";
    const n = whole.replace(/,/g, "");
    const c = cents ? cents.padEnd(2, "0") : "";
    const unit = spokenUnit(code, n, localCurrency);
    return c && c !== "00" ? `${n} ${unit} ${c}` : `${n} ${unit}`;
  });
}
