// GET /api/me (x-rove-session, any scope) → MeRes: everything /shop and /setup show
// Owner: Nithya · Task: NI-B5 · Spec: docs/specs/payments-stripe.md §5, docs/specs/web-app.md, docs/specs/withdrawals.md §1
//
// reconciled ("Ledger ✓ matches XRPL"): ledger available + held == settlement.balance(merchant XRPL account), compared
// exactly as decimals. Omitted when the merchant has no XRPL account yet, or the engine fails or takes > 1.5s.

import { add, MeRes, toUnits, type Balance, type Merchant, type Money } from "@rove/shared";
import { getWebDeps, type WebDeps } from "../_lib/deps";
import { HttpError, route } from "../_lib/http";
import { requireSession, type SessionScope } from "../_lib/session";
import { toBankAccountView, toWithdrawalView } from "../_lib/views";
import { merchantVerified, respond, withTimeout } from "../shops/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANY_SCOPE: SessionScope[] = ["setup", "bank", "shop", "withdrawal", "sale"];
const RECONCILE_TIMEOUT_MS = 1_500;
const RECENT_PAYMENTS = 10;
const RECENT_WITHDRAWALS = 10;

/** XRPL amounts can carry more places than the ledger's 2; compare at 18 so dust shows up as a mismatch. */
function sameAmount(a: Money, b: Money): boolean {
  return a.currency === b.currency && toUnits(a.amount, 18) === toUnits(b.amount, 18);
}

/** The merchant's stablecoin on XRPL in their currency (XSGD, EUR, …), or null when unknown (no account, engine error,
 *  timeout). Never throws. */
async function xrplBalance(deps: Pick<WebDeps, "settlement">, merchant: Merchant): Promise<Money | null> {
  if (!merchant.xrplAddress) return null;
  try {
    return await withTimeout(
      deps.settlement.balance({ merchantAddress: merchant.xrplAddress, currency: merchant.currency }),
      RECONCILE_TIMEOUT_MS,
      "balance",
    );
  } catch (err) {
    console.warn(`[api] /api/me: XRPL balance for ${merchant.id} unavailable; omitting reconciled:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function reconciledFlag(ledger: Balance, onchain: Money | null): boolean | undefined {
  if (!onchain) return undefined;
  try {
    return sameAmount(add(ledger.available, ledger.held), onchain);
  } catch {
    return undefined; // currency mismatch or an amount we can't read exactly
  }
}

export const GET = route(async (req) => {
  const session = requireSession(req, ANY_SCOPE);
  const deps = getWebDeps();
  const merchant = await deps.db.getMerchant(session.merchantId);
  if (!merchant) throw new HttpError(404, "merchant_not_found", "We couldn't find your shop. Text Rove for a new link.");
  const id = merchant.id;

  const [verified, onchain, balance, menu, contacts, openInvoices, payments, bankAccounts, withdrawals] = await Promise.all([
    merchantVerified(deps, merchant),
    xrplBalance(deps, merchant),
    deps.db.getBalance(id),
    deps.db.listMenu(id, { includeInactive: true }),
    deps.db.findContacts(id),
    deps.db.listInvoices(id, "open"),
    deps.db.listPayments(id, 50),
    deps.db.listBankAccounts(id),
    deps.db.listWithdrawals(id, RECENT_WITHDRAWALS),
  ]);
  const reconciled = reconciledFlag(balance, onchain);

  return respond(MeRes, {
    merchant: {
      id,
      name: merchant.name,
      category: merchant.category,
      currency: merchant.currency,
      status: merchant.status,
      autoWithdraw: merchant.autoWithdraw,
      verified,
    },
    balance: { available: balance.available, held: balance.held, total: balance.total },
    ...(reconciled === undefined ? {} : { reconciled }),
    menu: menu.map((m) => ({ id: m.id, name: m.name, price: m.price, active: m.active })),
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
    openInvoices: openInvoices.map((inv) => ({ code: inv.code, to: inv.to?.phone ?? null, total: inv.total, createdAt: inv.createdAt })),
    // "created" = a checkout the customer never authorized (closed the Apple Pay sheet): not a payment yet.
    recentPayments: payments
      .filter((p) => p.status !== "created")
      .slice(0, RECENT_PAYMENTS)
      .map((p) => ({ id: p.id, local: p.local, status: p.status, source: p.source, createdAt: p.createdAt })),
    bankAccounts: bankAccounts.map(toBankAccountView),
    withdrawals: await Promise.all(withdrawals.slice(0, RECENT_WITHDRAWALS).map((w) => toWithdrawalView(deps, w))),
  });
});
