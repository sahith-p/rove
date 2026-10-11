"use client";
// The /bank form (SH-C1). Collects PayNow UEN / PayNow mobile / bank account + holder name and POSTs it once.
// Safety rules (CLAUDE.md): the account number is never logged, never put in a URL, and is wiped from state the
// moment it's submitted. Inputs deliberately have no `name`, so a pre-hydration native submit serializes nothing.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { AddBankAccountReq, AddBankAccountRes, BankAccountViewZ, ROUTES } from "@rove/shared";
import { Building2, ChevronDown, Landmark, Smartphone } from "lucide-react";
import { Button, IconBadge, Notice, Row, Rows } from "../../components";
import { FlagSG } from "../../components/icons";
import { maskAccount } from "../../lib/ui/format";
import { sessionHeaders } from "../../lib/ui/headers";
import { CheckIcon, LockIcon } from "./icons";
import styles from "./bank.module.css";

type Kind = "paynow_uen" | "paynow_mobile" | "bank_account";
type BankAccountView = z.infer<typeof BankAccountViewZ>;
type Field = "uen" | "mobile" | "bankName" | "accountNumber" | "holderName";
type Errors = Partial<Record<Field, string>>;

const KINDS: { value: Kind; label: string; Icon: typeof Building2 }[] = [
  { value: "paynow_uen", label: "PayNow UEN", Icon: Building2 },
  { value: "paynow_mobile", label: "PayNow mobile", Icon: Smartphone },
  { value: "bank_account", label: "Bank account", Icon: Landmark },
];

// `value` is what goes to the API (and shows on the success card / withdrawal labels: "DBS ••••1234").
const BANKS: { value: string; label: string }[] = [
  { value: "DBS", label: "DBS / POSB" },
  { value: "OCBC", label: "OCBC" },
  { value: "UOB", label: "UOB" },
  { value: "Standard Chartered", label: "Standard Chartered" },
  { value: "HSBC", label: "HSBC" },
  { value: "Maybank", label: "Maybank" },
  { value: "Citibank", label: "Citibank" },
  { value: "Trust Bank", label: "Trust Bank" },
  { value: "GXS", label: "GXS Bank" },
];

const FRIENDLY: Record<Field, string> = {
  uen: "Enter your 9 or 10 character UEN (letters and numbers).",
  mobile: "Enter your 8-digit Singapore mobile number.",
  bankName: "Choose your bank.",
  accountNumber: "Account numbers are 6 to 16 digits.",
  holderName: "Enter the name exactly as your bank has it.",
};

const MeBankAccountsZ = z.object({ bankAccounts: z.array(BankAccountViewZ) });

export interface BankFormProps {
  token: string;
  /** NEXT_PUBLIC_DEMO_FIXTURES=1: simulate a verified save when the API isn't there yet. */
  demo: boolean;
  /** Demo only: the page rendered without a valid session token. */
  unverifiedSession: boolean;
}

export function BankForm({ token, demo, unverifiedSession }: BankFormProps) {
  const [hydrated, setHydrated] = useState(false);
  const [kind, setKind] = useState<Kind>("paynow_uen");
  const [uen, setUen] = useState("");
  const [mobile, setMobile] = useState(""); // 8 local digits; sent as +65XXXXXXXX
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<{ account: BankAccountView; simulated: boolean } | null>(null);
  const [current, setCurrent] = useState<BankAccountView | null>(null);

  useEffect(() => setHydrated(true), []);

  // The account already on file (the backend keeps the first one as default; a save adds another). Best effort: skipped silently if the API isn't there or won't say.
  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    fetch(ROUTES.me, { headers: sessionHeaders(token), signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        const parsed = MeBankAccountsZ.safeParse(json);
        if (!parsed.success) return;
        const list = parsed.data.bankAccounts;
        setCurrent(list.find((a) => a.isDefault) ?? list[0] ?? null);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [token]);

  function clearError(field: Field) {
    setFormError(null);
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  }

  function buildBody(): unknown {
    const name = holderName.trim().replace(/\s+/g, " ");
    switch (kind) {
      case "paynow_uen":
        return { type: kind, uen, holderName: name };
      case "paynow_mobile":
        return { type: kind, mobile: `+65${mobile}`, holderName: name };
      case "bank_account":
        return { type: kind, bankName, accountNumber, holderName: name };
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    const next: Errors = {};
    // Friendlier than the E.164 regex alone: SG mobiles are 8 digits starting 8 or 9.
    if (kind === "paynow_mobile" && !/^[89]\d{7}$/.test(mobile)) next.mobile = FRIENDLY.mobile;
    // The contract takes any string for bankName; only accept one from the picker.
    if (kind === "bank_account" && !BANKS.some((b) => b.value === bankName)) next.bankName = FRIENDLY.bankName;
    const parsed = AddBankAccountReq.safeParse(buildBody());
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string" && field in FRIENDLY) next[field as Field] ??= FRIENDLY[field as Field];
      }
    }
    if (Object.keys(next).length > 0 || !parsed.success) {
      setErrors(next);
      return;
    }

    const body = parsed.data;
    const last4 = lastFour(body);
    // Wipe the full account number from component state right away; only the request body still holds it.
    setAccountNumber("");
    setErrors({});
    setSubmitting(true);

    let res: Response | null = null;
    let json: unknown = null;
    try {
      res = await fetch(ROUTES.meBankAccounts, {
        method: "POST",
        headers: { "content-type": "application/json", ...sessionHeaders(token) },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      json = await res.json().catch(() => null);
    } catch {
      res = null;
    }

    const ok = res?.ok ? AddBankAccountRes.safeParse(json) : null;
    if (ok?.success) {
      setSubmitting(false);
      if (ok.data.status === "failed") {
        setFormError("We couldn't verify this account with the bank. Check the details and try again.");
        return;
      }
      setSaved({ account: ok.data, simulated: false });
      return;
    }

    // The payout partner couldn't verify the account: 422 { error, message }.
    if (res?.status === 422) {
      setSubmitting(false);
      setFormError(
        `${errorText(json) ?? "We couldn't verify this account with the bank. Check the details and try again."}${
          body.type === "bank_account" ? " For your safety, re-enter the account number." : ""
        }`,
      );
      return;
    }

    if (demo) {
      // API not live yet (501) or unreachable: simulate the partner's verified response.
      setSubmitting(false);
      setSaved({
        account: {
          id: "demo_bank_account",
          type: body.type,
          bankName: body.type === "bank_account" ? body.bankName : null,
          last4,
          holderName: body.holderName.toUpperCase(),
          status: "verified",
          isDefault: true,
        },
        simulated: true,
      });
      return;
    }

    setSubmitting(false);
    if (res?.status === 401 || res?.status === 403) {
      setFormError("This link expired (links last 15 minutes). Text Rove 'add my bank' for a new one.");
    } else {
      const reason = errorText(json);
      setFormError(
        `${reason ?? "We couldn't save your details. Please try again."}${
          body.type === "bank_account" ? " For your safety, re-enter the account number." : ""
        }`,
      );
    }
  }

  if (saved) return <Saved account={saved.account} simulated={saved.simulated} replaced={current} />;

  return (
    <form className={styles.form} onSubmit={onSubmit} method="post" noValidate autoComplete="off">
      {unverifiedSession ? (
        <Notice variant="simulated" title="Demo mode">
          No valid link token, so nothing here is tied to a real shop.
        </Notice>
      ) : null}

      {current ? (
        <div className={styles.field}>
          <Rows>
            <Row label="On file" value={`${accountLabel(current)} · ${current.holderName}`} />
          </Rows>
          <p className={styles.hint}>Adds this account for withdrawals. Your first account stays the default.</p>
        </div>
      ) : null}

      <div className={styles.field}>
      <span className={styles.label} aria-hidden="true">
        Payouts go to
      </span>
      <div className={styles.segmented} role="radiogroup" aria-label="Where should payouts go?">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={kind === k.value}
            className={[styles.segment, kind === k.value && styles.segmentActive].filter(Boolean).join(" ")}
            onClick={() => {
              setKind(k.value);
              setErrors({});
              setFormError(null);
            }}
            disabled={submitting}
          >
            <k.Icon size={18} strokeWidth={1.5} aria-hidden="true" />
            {k.label}
          </button>
        ))}
      </div>
      </div>

      {kind === "paynow_uen" ? (
        <FieldShell label="UEN" hint="Your business registration number, e.g. 201912345K" error={errors.uen}>
          {(p) => (
            <input
              {...p}
              className={styles.input}
              value={uen}
              onChange={(e) => {
                setUen(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 10));
                clearError("uen");
              }}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              placeholder="201912345K"
              maxLength={10}
            />
          )}
        </FieldShell>
      ) : null}

      {kind === "paynow_mobile" ? (
        <FieldShell label="PayNow mobile number" hint="The Singapore number registered with PayNow" error={errors.mobile}>
          {(p) => (
            <div className={[styles.prefixWrap, p["aria-invalid"] && styles.prefixInvalid].filter(Boolean).join(" ")}>
              <span className={styles.prefix} aria-hidden="true">
                <FlagSG size={16} />
                +65
              </span>
              <input
                {...p}
                className={styles.prefixInput}
                type="tel"
                inputMode="tel"
                value={formatMobile(mobile)}
                onChange={(e) => {
                  setMobile(normalizeMobile(e.target.value));
                  clearError("mobile");
                }}
                autoComplete="off"
                placeholder="9123 4567"
              />
            </div>
          )}
        </FieldShell>
      ) : null}

      {kind === "bank_account" ? (
        <>
          <FieldShell label="Bank" error={errors.bankName}>
            {(p) => (
              <div className={styles.selectWrap}>
                <select
                  {...p}
                  className={[styles.input, styles.select, !bankName && styles.placeholder].filter(Boolean).join(" ")}
                  value={bankName}
                  onChange={(e) => {
                    setBankName(e.target.value);
                    clearError("bankName");
                  }}
                >
                  <option value="" disabled>
                    Choose your bank
                  </option>
                  {BANKS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={18} strokeWidth={1.5} className={styles.selectChevron} aria-hidden="true" />
              </div>
            )}
          </FieldShell>
          <FieldShell label="Account number" hint="Digits only, no dashes" error={errors.accountNumber}>
            {(p) => (
              <input
                {...p}
                className={[styles.input, styles.number].join(" ")}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={accountNumber}
                onChange={(e) => {
                  setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 16));
                  clearError("accountNumber");
                }}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                placeholder="0123456789"
                maxLength={16}
              />
            )}
          </FieldShell>
        </>
      ) : null}

      <FieldShell
        label="Account holder name"
        hint={kind === "paynow_mobile" ? "As registered with PayNow" : "Exactly as registered with your bank"}
        error={errors.holderName}
      >
        {(p) => (
          <input
            {...p}
            className={styles.input}
            value={holderName}
            onChange={(e) => {
              setHolderName(e.target.value.slice(0, 120));
              clearError("holderName");
            }}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            placeholder="AH SENG FOOD PTE LTD"
          />
        )}
      </FieldShell>

      {formError ? <Notice variant="error">{formError}</Notice> : null}

      <Button type="submit" fullWidth loading={submitting} disabled={!hydrated} icon={<LockIcon size={17} />}>
        {submitting ? "Saving securely…" : "Save bank details"}
      </Button>

      <p className={styles.footnote}>
        <LockIcon size={14} />
        Sent over an encrypted connection. Rove never stores the full number.
      </p>
    </form>
  );
}

function Saved({ account, simulated, replaced }: { account: BankAccountView; simulated: boolean; replaced: BankAccountView | null }) {
  const pending = account.status === "pending";
  return (
    <div className={styles.form} aria-live="polite">
      <section className={styles.success}>
        <IconBadge tone={pending ? "neutral" : "success"} size="lg">
          <CheckIcon size={28} />
        </IconBadge>
        <h2 className="twoTone">
          <span>{pending ? "Saved, verifying" : "Saved"}</span>
          <span>You can close this and go back to Rove.</span>
        </h2>
      </section>
      <Rows label="Payout account">
        <Row label="Account" value={accountLabel(account)} mono />
        <Row label="Name" value={account.holderName} />
        {replaced && replaced.id !== account.id ? <Row label="Default" value={accountLabel(replaced)} tone="muted" /> : null}
      </Rows>
      {pending ? <p className={styles.hint}>The bank is confirming the name. Rove will text you when it&rsquo;s done.</p> : null}
      {simulated ? (
        <Notice variant="simulated" title="Payout partner simulated (demo)">
          Nothing was sent to a bank. The name is shown as entered.
        </Notice>
      ) : null}
    </div>
  );
}

/** Wraps a field with its label, hint and inline error, and hands the control its a11y props. */
function FieldShell({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (p: { id: string; "aria-invalid": boolean | undefined; "aria-describedby": string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = error ? errId : hint ? hintId : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {error ? (
        <p id={errId} className={styles.error} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function lastFour(body: z.infer<typeof AddBankAccountReq>): string {
  const raw = body.type === "paynow_uen" ? body.uen : body.type === "paynow_mobile" ? body.mobile : body.accountNumber;
  return raw.slice(-4);
}

function accountLabel(a: Pick<BankAccountView, "type" | "bankName" | "last4">): string {
  const prefix = a.type === "bank_account" ? (a.bankName ?? "Bank") : a.type === "paynow_uen" ? "PayNow UEN" : "PayNow";
  return `${prefix} ${maskAccount(a.last4)}`;
}

/** Digits only; drops a pasted +65 / 65 country code. Max 8 local digits. */
function normalizeMobile(input: string): string {
  let d = input.replace(/\D/g, "");
  if (d.length > 8 && d.startsWith("65")) d = d.slice(2);
  return d.slice(0, 8);
}

function formatMobile(d: string): string {
  return d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
}

/** The API's merchant-friendly `message` (never the `error` code, e.g. "account_not_verified"), or null. */
function errorText(json: unknown): string | null {
  if (json && typeof json === "object" && "message" in json && typeof json.message === "string") {
    const msg = json.message.trim();
    // Don't surface internal stub messages like "not implemented: NI-B6".
    if (msg && msg.length < 200 && !/not implemented/i.test(msg)) return msg;
  }
  return null;
}
