// Test helpers for the NI-B4 / NI-B5 route tests (tests only; no route imports this). Owner: Nithya.
// Seeds rows through the real Db interface (PGlite via createWebTestDeps) and stubs the read-only settlement engine.

import type { Db } from "@rove/db";
import { money, newId, SESSION_HEADER, type CredentialStatus, type InvoiceLine, type Merchant, type Money, type Payment } from "@rove/shared";
import type { WebSettlement } from "../_lib/deps";
import { sessionToken } from "../_lib/testing";

export const sgd = (amount: string): Money => money(amount, "SGD");
export const TX = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";

export async function seedMerchant(
  db: Db,
  m: { id?: string; name?: string; phone?: string; live?: boolean; xrplAddress?: string; credentialStatus?: CredentialStatus } = {},
): Promise<Merchant> {
  const id = m.id ?? "ahseng";
  await db.upsertDraftMerchant({ id, name: m.name ?? "Ah Seng Chicken Rice", phone: m.phone ?? "+6580000001", channel: "imessage", category: "hawker" });
  if (m.xrplAddress) await db.setMerchantXrpl(id, { xrplAddress: m.xrplAddress, xrplSeedEnc: "enc:test", credentialStatus: m.credentialStatus ?? "accepted" });
  if (m.live ?? true) await db.setMerchantLive(id);
  const merchant = await db.getMerchant(id);
  if (!merchant) throw new Error("seedMerchant: merchant missing");
  return merchant;
}

export const LINES: InvoiceLine[] = [
  { menuItemId: null, name: "Chicken rice", qty: 2, unit: sgd("5.50") },
  { menuItemId: null, name: "Barley drink", qty: 1, unit: sgd("1.50") },
];

/** A single free-amount line (the DB checks Σ qty × unit = total). */
export const one = (amount: string): InvoiceLine[] => [{ menuItemId: null, name: "Amount", qty: 1, unit: sgd(amount) }];

/** A payment walked to `to` through the real transitions (settled = completeSettlement: ledger credit + contact). */
export async function seedPayment(
  db: Db,
  merchantId: string,
  o: { to?: "created" | "authorized" | "settled"; payerPhone?: string | null; local?: Money; charge?: Money; source?: Payment["source"] } = {},
): Promise<Payment> {
  const local = o.local ?? sgd("12.50");
  const p = await db.insertPayment({
    id: newId("pay"),
    merchantId,
    source: o.source ?? "fixed_qr",
    invoiceId: null,
    lines: o.local ? [] : LINES,
    local,
    quote: null,
    charge: o.charge ?? local,
    method: "apple_pay",
    payer: o.payerPhone === null ? null : { phone: o.payerPhone ?? "+6591234567", channel: "imessage" },
  });
  const to = o.to ?? "settled";
  if (to === "created") return p;
  await db.transitionPayment(p.id, ["created"], "authorized");
  if (to === "authorized") return (await db.getPayment(p.id))!;
  await db.transitionPayment(p.id, ["authorized"], "settling");
  const done = await db.completeSettlement(p.id, { txHash: TX, delivered: local.amount });
  if (!done) throw new Error("seedPayment: completeSettlement returned null");
  return done.payment;
}

export function get(url: string, session?: string): Request {
  return new Request(url, { headers: session ? { [SESSION_HEADER]: session } : {} });
}

export function put(url: string, body: unknown, session?: string): Request {
  return new Request(url, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(session ? { [SESSION_HEADER]: session } : {}) },
  });
}

export const token = sessionToken;

type Outcome<T> = T | Error | "hang";

/** Read-only settlement stub: answers (or throws, or never answers) per call, and counts calls. */
export function stubSettlement(init: { verified?: Outcome<boolean>; balance?: Outcome<Money> } = {}) {
  const state = { verified: init.verified ?? true, balance: init.balance ?? sgd("0") };
  const calls = { verified: [] as string[], balance: [] as string[] };
  const answer = <T>(o: Outcome<T>): Promise<T> =>
    o === "hang" ? new Promise<T>(() => {}) : o instanceof Error ? Promise.reject(o) : Promise.resolve(o);
  const settlement: WebSettlement = {
    quote: async () => {
      throw new Error("quote is not used by these routes");
    },
    isVerifiedMerchant: (address) => (calls.verified.push(address), answer(state.verified)),
    balance: ({ merchantAddress }) => (calls.balance.push(merchantAddress), answer(state.balance)),
    explorerUrl: (hash) => `https://testnet.xrpl.org/transactions/${hash}`,
  };
  return { settlement, calls, state };
}
