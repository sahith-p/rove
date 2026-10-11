// Currency registry: every fiat currency Rove knows, and whether it has a stablecoin on XRPL we can settle in.
// Spec: docs/specs/corridors.md. `Currency`, `CurrencyZ`, `DECIMALS` and the format() symbols all derive from here.
//
// The model: the payer pays in their own currency (card charged in that currency, or that currency's stablecoin),
// Rove's treasury holds a float of each enabled stablecoin on XRPL, and one XRPL Payment swaps it at the market rate
// through the RLUSD hub (an AMM pool per currency against RLUSD) into the merchant's currency. No card-network FX.
//
// A currency is ENABLED (a valid `Currency`, for payers and merchants) when its stablecoin is "live-on-testnet":
// the seed issues a stand-in with that code, creates its RLUSD pool and funds the treasury float.
// "planned" entries are documentation + routing data only (phone/country lookups still find them).
//
// Adding a currency: docs/specs/corridors.md §4 (registry entry + issuer env + pool + payout partner + payer rail).
// No imports: money.ts imports this file.

export type StablecoinStatus = "live-on-testnet" | "planned";

/** How a payer can pay in this currency. card = Apple Pay / card via Stripe charged in this currency (no card FX);
 *  stablecoin = the currency's stablecoin from a wallet; upi / pix = local instant-payment rails via a licensed partner. */
export type PayerRail = "card" | "stablecoin" | "upi" | "pix";

export interface StablecoinInfo {
  /** Currency code on XRPL (3 chars as-is, longer codes are hex-encoded on the ledger). Testnet: a stand-in we issue. */
  xrplCode: string;
  /** Env var holding the issuer address (seed: `${issuerEnv}_SEED`). */
  issuerEnv: string;
  /** The production stablecoin this stands in for. */
  realWorld: string;
  status: StablecoinStatus;
}

export interface CurrencyInfo {
  /** ISO 4217 */
  code: string;
  name: string;
  /** Minor-unit decimals (ISO 4217). Money amounts never carry more. */
  decimals: number;
  /** Display prefix used by format(): "S$6.50" */
  symbol: string;
  /** ISO 3166-1 alpha-2 countries/territories whose people and shops use this currency. */
  countries: readonly string[];
  /** E.164 country calling codes, without "+". Country codes are prefix-free, so the longest match wins. */
  phonePrefixes: readonly string[];
  /** null: no stablecoin for this currency on XRPL that we know of. */
  stablecoin: StablecoinInfo | null;
  /** Payout partner id for bank withdrawals (behind the PayoutPartner interface), or null if none chosen yet. */
  payout: string | null;
  payerRails: readonly PayerRail[];
  /** Honest one-liner for docs and the agent: what's real, what's missing. */
  note: string;
}

const EURO_AREA = [
  // EU members using the euro (Bulgaria joined 1 January 2026)
  "AT", "BE", "BG", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
  // non-EU users of the euro
  "AD", "MC", "SM", "VA", "ME", "XK",
] as const;

const EURO_AREA_PHONES = [
  "43", "32", "359", "385", "357", "372", "358", "33", "49", "30", "353", "39", "371", "370", "352", "356", "31", "351", "421", "386", "34",
  "376", "377", "378", "379", "382", "383",
] as const;

/**
 * The registry. Order = display order (enabled first). Enabled entries must have `stablecoin.status: "live-on-testnet"`.
 */
const REGISTRY = {
  SGD: {
    code: "SGD",
    name: "Singapore dollar",
    decimals: 2,
    symbol: "S$",
    countries: ["SG"],
    phonePrefixes: ["65"],
    stablecoin: {
      xrplCode: "XSGD",
      issuerEnv: "XRPL_SGD_ISSUER",
      realWorld: "XSGD by StraitsX (MAS-licensed; live on XRPL since May 2025)",
      status: "live-on-testnet",
    },
    payout: "straitsx",
    payerRails: ["card", "stablecoin"],
    note: "The demo corridor. Bank withdrawals redeem XSGD with StraitsX and pay out over PayNow/FAST (simulated in the demo).",
  },
  USD: {
    code: "USD",
    name: "US dollar",
    decimals: 2,
    symbol: "US$",
    countries: ["US", "PR", "GU", "VI", "AS", "MP", "EC", "SV", "PA", "TL", "FM", "MH", "PW"],
    // +1 is shared by the whole North American Numbering Plan; non-US +1 payers fall back to USD anyway.
    phonePrefixes: ["1", "593", "503", "507", "670", "691", "692", "680"],
    stablecoin: {
      xrplCode: "RLUSD",
      issuerEnv: "XRPL_USD_ISSUER",
      realWorld: "RLUSD by Ripple (NYDFS-regulated trust company; native on XRPL)",
      status: "live-on-testnet",
    },
    payout: null,
    payerRails: ["card", "stablecoin"],
    note: "The hub: every other currency has an AMM pool against RLUSD, so any pair settles in one Payment. Also the fallback payer currency. No USD bank-payout partner chosen yet (merchants can withdraw RLUSD to their own wallet).",
  },
  EUR: {
    code: "EUR",
    name: "Euro",
    decimals: 2,
    symbol: "€",
    countries: EURO_AREA,
    phonePrefixes: EURO_AREA_PHONES,
    stablecoin: {
      xrplCode: "EUR",
      issuerEnv: "XRPL_ISSUER_EUR",
      realWorld:
        "a MiCA-regulated euro e-money token issued on XRPL; e.g. Schuman Financial's EURØP (native XRPL integration announced by Ripple, 22 May 2025). The testnet stand-in uses the plain ISO code, not that token's.",
      status: "live-on-testnet",
    },
    payout: null,
    payerRails: ["card", "stablecoin"],
    note: "Testnet stand-in issued by Rove. Production uses whichever regulated euro stablecoin is issued on XRPL, redeemed by its issuer with a SEPA payout partner (not chosen yet).",
  },
  INR: {
    code: "INR",
    name: "Indian rupee",
    decimals: 2,
    symbol: "₹",
    countries: ["IN"],
    phonePrefixes: ["91"],
    stablecoin: null,
    payout: null,
    payerRails: ["upi"],
    note: "No INR stablecoin on XRPL that we know of. Needs a licensed Indian partner: payers on UPI, merchants paid out to bank/UPI, the float stays in USD.",
  },
  AUD: {
    code: "AUD",
    name: "Australian dollar",
    decimals: 2,
    symbol: "A$",
    countries: ["AU", "CX", "CC", "NF", "KI", "NR", "TV"],
    phonePrefixes: ["61", "672", "686", "674", "688"],
    stablecoin: {
      xrplCode: "AUDD",
      issuerEnv: "XRPL_ISSUER_AUD",
      realWorld: "AUDD by Novatti (live on XRPL per Ripple, 13 June 2023)",
      status: "planned",
    },
    payout: null,
    payerRails: ["card", "stablecoin"],
    note: "A stablecoin exists on XRPL; enabling it needs the stand-in issuer + RLUSD pool in the seed and an AUD payout partner.",
  },
  BRL: {
    code: "BRL",
    name: "Brazilian real",
    decimals: 2,
    symbol: "R$",
    countries: ["BR"],
    phonePrefixes: ["55"],
    stablecoin: {
      xrplCode: "BBRL",
      issuerEnv: "XRPL_ISSUER_BRL",
      realWorld: "BBRL by Braza Group (launch on XRPL announced by Ripple, 19 February 2025; institutional access first)",
      status: "planned",
    },
    payout: null,
    payerRails: ["card", "stablecoin"],
    note: "A stablecoin was announced on XRPL; enabling it needs the stand-in + pool, a BRL payout partner, and Pix as a payer rail later.",
  },
} as const satisfies Record<string, CurrencyInfo>;

type Registry = typeof REGISTRY;
type LiveCode<K extends keyof Registry> = Registry[K] extends { stablecoin: { status: "live-on-testnet" } } ? K : never;

/** A currency Rove can settle in today (testnet): "SGD" | "USD" | "EUR". Money.currency is always one of these. */
export type Currency = { [K in keyof Registry]: LiveCode<K> }[keyof Registry];
/** Any currency in the registry, enabled or planned. */
export type KnownCurrencyCode = keyof Registry;

const ALL: readonly CurrencyInfo[] = Object.values(REGISTRY);

const isLive = (c: CurrencyInfo): boolean => c.stablecoin?.status === "live-on-testnet";

/** Enabled currency codes, registry order. Non-empty (z.enum needs a tuple). */
export const CURRENCY_CODES = ALL.filter(isLive).map((c) => c.code) as unknown as readonly [Currency, ...Currency[]];

/** The settlement hub: every other enabled currency has an AMM pool against its stablecoin (RLUSD). */
export const HUB_CURRENCY: Currency = "USD";

/** Payer currency when nothing else decides it (unknown phone country, no locale hint). */
export const DEFAULT_PAYER_CURRENCY: Currency = "USD";

/** Every registry entry (enabled + planned). */
export function allCurrencies(): readonly CurrencyInfo[] {
  return ALL;
}

/** Entries Rove can settle in today, registry order. */
export function enabledCurrencies(): readonly CurrencyInfo[] {
  return ALL.filter(isLive);
}

/** The registry entry for a code (case-insensitive), enabled or planned; undefined if unknown. */
export function getCurrency(code: string): CurrencyInfo | undefined {
  return ALL.find((c) => c.code === code.toUpperCase());
}

/** Type guard: an enabled currency code (exact case). */
export function isCurrency(code: unknown): code is Currency {
  return typeof code === "string" && (CURRENCY_CODES as readonly string[]).includes(code);
}

/** Can a merchant hold their balance in this currency? = it has a live stablecoin on XRPL. */
export function isMerchantCurrency(code: unknown): code is Currency {
  return isCurrency(code);
}

/** Registry entry for an enabled currency (throws on anything else: a bug, since Currency is a closed union). */
export function currencyInfo(code: Currency): CurrencyInfo {
  const c = getCurrency(code);
  if (!c || !isLive(c)) throw new Error(`not an enabled currency: ${code}`);
  return c;
}

/**
 * The registry entry for a phone number's country (enabled or planned), by longest E.164 country-code match.
 * "+6591234567" → SGD · "+14155550123" → USD · "+4915112345678" → EUR · "+919876543210" → INR (planned) · unknown → null.
 */
export function currencyForPhone(e164: string): CurrencyInfo | null {
  const digits = e164.trim().replace(/^\+/, "").replace(/[\s().-]/g, "");
  if (!/^\d{4,15}$/.test(digits)) return null;
  let best: { c: CurrencyInfo; len: number } | null = null;
  for (const c of ALL) {
    for (const p of c.phonePrefixes) {
      if (digits.startsWith(p) && (!best || p.length > best.len)) best = { c, len: p.length };
    }
  }
  return best?.c ?? null;
}

/** The registry entry for an ISO 3166-1 alpha-2 country (case-insensitive), enabled or planned; null if unknown. */
export function currencyForCountry(cc: string): CurrencyInfo | null {
  const up = cc.trim().toUpperCase();
  return ALL.find((c) => c.countries.includes(up)) ?? null;
}

/**
 * The currency to charge a payer in: an explicit enabled choice wins, else the phone's country if that currency is
 * enabled, else the country's, else USD. Planned currencies (e.g. INR) fall back to USD until they get a rail.
 */
export function payerCurrencyFor(input: { requested?: string | null; phone?: string | null; country?: string | null }): Currency {
  if (isCurrency(input.requested)) return input.requested;
  const byPhone = input.phone ? currencyForPhone(input.phone) : null;
  if (byPhone && isCurrency(byPhone.code)) return byPhone.code;
  const byCountry = input.country ? currencyForCountry(input.country) : null;
  if (byCountry && isCurrency(byCountry.code)) return byCountry.code;
  return DEFAULT_PAYER_CURRENCY;
}
