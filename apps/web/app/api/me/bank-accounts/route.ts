// POST /api/me/bank-accounts (bank scope): partner beneficiary, store id + last4 only → emits bank_account.added (after())
// Owner: Nithya · Task: NI-B6 · Spec: docs/specs/withdrawals.md §2, docs/specs/corridors.md · Schemas: @rove/shared api.ts
//
// The raw account number / UEN / mobile / IBAN lives only in this request: it goes to the payout partner and nowhere
// else. Not into the DB (we keep beneficiaryId + last4 + the partner's resolved name), not into logs, error messages, the
// response or the event. Validation errors name the bad fields but never echo what was sent.
//
// Account types follow the merchant's currency (registry `payout` → payouts.ts bankAccountTypesFor): SGD shops add PayNow
// UEN / PayNow mobile / a bank account (StraitsX-shaped partner), EUR shops add an IBAN (SEPA-shaped partner, IBAN in
// `accountNumber`). A currency without a payout partner (USD today) can't add one: those shops withdraw to a wallet.

import { after } from "next/server";
import type { z } from "zod";
import { AddBankAccountReq, bankAccountTypesFor, normalizeIban, type Beneficiary, type BeneficiaryInput, type Merchant } from "@rove/shared";
import { getWebDeps } from "../../_lib/deps";
import { errorJson, HttpError, json, readJson, route } from "../../_lib/http";
import { requireSession } from "../../_lib/session";
import { bankLabel, toBankAccountView } from "../../_lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = z.infer<typeof AddBankAccountReq>;

const FIELD_NAMES: Record<string, string> = {
  type: "account type",
  uen: "UEN",
  mobile: "mobile number",
  bankName: "bank",
  accountNumber: "account number",
  holderName: "account holder name",
};

/** 6+ digits in a row (optionally spaced or dashed): an account number, UEN or phone, never part of a name. */
const NUMBER_RUN = /\+?\d[\d\s-]{4,}\d/g;

export const POST = route(async (req) => {
  const session = requireSession(req, ["bank"]);

  let body: Body;
  try {
    body = await readJson(req, AddBankAccountReq);
  } catch (err) {
    if (isZodError(err)) return invalidBody(err.issues);
    throw err;
  }

  const holderName = body.holderName.trim().replace(/\s+/g, " ");
  const bankName = body.type === "bank_account" ? body.bankName.trim() : body.type === "iban" ? body.bankName?.trim() || null : null;
  const bad: { path: string[]; code: string }[] = [];
  if (holderName.length < 2 || hasNumberRun(holderName)) bad.push({ path: ["holderName"], code: "invalid_name" });
  if (body.type === "bank_account" && (!bankName || bankName.length > 40 || hasNumberRun(bankName))) {
    bad.push({ path: ["bankName"], code: "invalid_bank" });
  }
  if (body.type === "iban" && bankName && (bankName.length > 40 || hasNumberRun(bankName))) bad.push({ path: ["bankName"], code: "invalid_bank" });
  if (bad.length) return invalidBody(bad);

  const { db, payouts, emit } = getWebDeps();
  const merchantId = session.merchantId;
  const merchant = await db.getMerchant(merchantId);
  if (!merchant) {
    throw new HttpError(404, "merchant_not_found", "We couldn't find your shop. Text Rove 'add my bank' for a new link.");
  }
  checkTypeForCurrency(merchant, body.type);

  const secret =
    body.type === "bank_account" ? body.accountNumber : body.type === "iban" ? normalizeIban(body.accountNumber) : body.type === "paynow_uen" ? body.uen : body.mobile;
  const input: BeneficiaryInput =
    body.type === "bank_account"
      ? { merchantId, type: body.type, bankName: bankName!, accountNumber: secret, holderName, currency: merchant.currency }
      : body.type === "iban"
        ? { merchantId, type: body.type, ...(bankName ? { bankName } : {}), accountNumber: secret, holderName, currency: merchant.currency }
        : { merchantId, type: body.type, proxy: secret, holderName, currency: merchant.currency };

  let beneficiary: Beneficiary;
  try {
    beneficiary = await payouts.createBeneficiary(input);
  } catch (err) {
    // The partner's error may quote what we sent: log a scrubbed message only (no stack, no request body).
    console.error(`[api] POST /api/me/bank-accounts: payout partner error for ${merchantId}: ${redact(errText(err), secret)}`);
    throw new HttpError(502, "partner_unavailable", "Our payout partner didn't respond. Please try again in a minute.");
  }

  if (beneficiary.status === "failed") {
    throw new HttpError(
      422,
      "account_not_verified",
      body.type === "bank_account"
        ? "Your bank couldn't verify this account. Check the bank, account number and name, then try again."
        : body.type === "iban"
          ? "The bank couldn't verify this IBAN. Check it and the account holder name, then try again."
          : `PayNow couldn't verify this ${body.type === "paynow_uen" ? "UEN" : "mobile number"}. Check it and the name, then try again.`,
    );
  }

  const account = await db.insertBankAccount({
    merchantId,
    type: body.type,
    bankName,
    // Never more than 4 characters, whatever the partner sends back.
    last4: (beneficiary.last4 || secret).slice(-4),
    holderName: redact(beneficiary.resolvedName?.trim() || holderName, secret),
    beneficiaryId: beneficiary.beneficiaryId,
    status: beneficiary.status,
  });

  // "DBS ••••1234 (AH SENG FOOD PTE LTD)" · "PayNow ••••1234 (…)" · "IBAN ••••3000 (CAFÉ BERLIN GMBH)"
  // emit() retries a down agent for up to ~17s, so it runs after the response (Next's after(), waitUntil on Vercel),
  // like /api/me/shop. Outside a Next request scope (tests, scripts) after() throws, so it's awaited instead.
  const send = () => emit({ type: "bank_account.added", merchantId, bankAccountId: account.id, label: `${bankLabel(account)} (${account.holderName})` });
  try {
    after(send);
  } catch {
    await send(); // never rejects (emit logs its own failures)
  }

  return json(toBankAccountView(account), { status: 201 });
});

// ------------------------------------------------------------------ helpers

/** 422 when the account type can't receive the shop's currency (an IBAN for an SGD shop, PayNow for an EUR shop, any bank for USD). */
function checkTypeForCurrency(merchant: Merchant, type: Body["type"]): void {
  const allowed = bankAccountTypesFor(merchant.currency);
  if (allowed.includes(type)) return;
  if (allowed.length === 0) {
    throw new HttpError(
      422,
      "bank_payouts_unavailable",
      `Bank payouts in ${merchant.currency} aren't available yet. You can withdraw to your own XRPL wallet instead.`,
    );
  }
  const want = allowed.includes("iban") ? "an IBAN" : "PayNow or a Singapore bank account";
  throw new HttpError(422, "account_type_not_supported", `Your shop is paid out in ${merchant.currency}, so add ${want}.`);
}

type Issue = { path: (string | number)[]; code: string };

/** 400 that names the fields but never echoes values (zod issues can carry `received`; we keep path + code only). */
function invalidBody(issues: Issue[]): Response {
  const fields = [...new Set(issues.map((i) => FIELD_NAMES[String(i.path[0])] ?? "details"))];
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}` : fields[0];
  return errorJson(400, "invalid_body", `Check the ${list}, then try again.`, {
    issues: issues.map((i) => ({ path: i.path, code: i.code })),
  });
}

function isZodError(err: unknown): err is { issues: Issue[] } {
  return err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues);
}

function hasNumberRun(s: string): boolean {
  return new RegExp(NUMBER_RUN.source).test(s);
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Removes the submitted number (as sent, and digits only) and any long digit run from text bound for logs or the DB. */
function redact(text: string, secret: string): string {
  let out = text;
  const digits = secret.replace(/\D/g, "");
  for (const s of [secret, digits]) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out.replace(NUMBER_RUN, "[redacted]");
}
