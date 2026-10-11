// Currency codes, issued amounts and XRPL value parsing. Spec: docs/specs/settlement-xrpl.md §1.

/** Our stand-in tokens. Mainnet would use real RLUSD (Ripple) and XSGD (StraitsX) with the same codes. */
export const USD_CODE = "RLUSD";
export const SGD_CODE = "XSGD";

/** XRPL Credential type for verified merchants (NI-A4). */
export const VERIFIED_MERCHANT_CREDENTIAL = "ROVE_VERIFIED_MERCHANT";

const STANDARD_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CODE = /^[0-9A-Fa-f]{40}$/;

/**
 * The on-ledger form of a currency code. 3-character codes are used as-is ("USD").
 * Longer codes must be 40-hex: the ASCII bytes, upper-case, right-padded with zeros ("XSGD" → "58534744000…").
 * An already-hex code passes through (upper-cased).
 */
export function currencyHex(code: string): string {
  if (HEX_CODE.test(code)) return code.toUpperCase();
  if (code.length === 3) {
    if (!STANDARD_CODE.test(code)) throw new Error(`invalid currency code: ${code}`);
    if (code.toUpperCase() === "XRP") throw new Error("XRP is not an issued currency");
    return code;
  }
  if (code.length < 3 || code.length > 20) throw new Error(`currency code must be 3-20 characters: ${code}`);
  if (!/^[\x20-\x7E]+$/.test(code)) throw new Error(`currency code must be printable ASCII: ${code}`);
  return Buffer.from(code, "ascii").toString("hex").toUpperCase().padEnd(40, "0");
}

/** Inverse of currencyHex: "58534744000…" → "XSGD"; 3-character codes pass through. */
export function currencyFromHex(code: string): string {
  if (!HEX_CODE.test(code)) return code;
  return Buffer.from(code, "hex").toString("ascii").replace(/\0+$/, "");
}

/** True when two codes name the same currency (handles "XSGD" vs its hex form). */
export function sameCurrency(a: string, b: string): boolean {
  return currencyHex(a) === currencyHex(b);
}

/** Credential types are arbitrary bytes on the ledger; we use the UTF-8 hex of the name. */
export function credentialTypeHex(name: string): string {
  return Buffer.from(name, "utf8").toString("hex").toUpperCase();
}

export interface IssuedAmount {
  currency: string;
  issuer: string;
  value: string;
}

export function issued(code: string, issuer: string, value: string): IssuedAmount {
  return { currency: currencyHex(code), issuer, value };
}

const XRPL_VALUE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Normalise an XRPL issued-currency value into a plain decimal string.
 * rippled may return "12.5", "1250e-2" or "1.25E1"; all become "12.5". "-0.5" stays negative.
 */
export function plainDecimal(value: string): string {
  const m = XRPL_VALUE.exec(value.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`invalid XRPL value: ${value}`);
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const exp = Number(m[4] ?? "0") - fracPart.length;
  let digits = (intPart + fracPart).replace(/^0+/, "");
  if (digits === "") return "0";
  let out: string;
  if (exp >= 0) {
    out = digits + "0".repeat(exp);
  } else {
    const point = digits.length + exp; // position of the decimal point
    if (point <= 0) digits = "0".repeat(1 - point) + digits;
    const p = digits.length + exp;
    out = `${digits.slice(0, p)}.${digits.slice(p)}`.replace(/\.?0+$/, "");
  }
  return out === "0" ? "0" : sign + out;
}
