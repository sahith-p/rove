// Every public URL in one place, so the agent, cards, QR codes and web app agree.
// Pages live in apps/web/app (Sahith). Merchant pages carry a signed session token `t` (tokens.ts).

export function links(base: string) {
  const b = base.replace(/\/$/, "");
  return {
    /** Customer: pay an invoice or one-time QR. */
    pay: (code: string) => `${b}/pay/${code}`,
    /** Customer: fixed shop QR (enter amount or pick from the menu). */
    shop: (merchantId: string) => `${b}/m/${merchantId}`,
    /** Customer: receipt. paymentId is unguessable. */
    receipt: (paymentId: string) => `${b}/r/${paymentId}`,
    /** Merchant: shop setup mini-app (name, category, menu). */
    setup: (t: string) => `${b}/setup?t=${t}`,
    /** Merchant: secure bank details form. */
    bank: (t: string) => `${b}/bank?t=${t}`,
    /** Merchant: minimal "my shop" page (balance, payments, invoices, contacts, menu). */
    myShop: (t: string) => `${b}/shop?t=${t}`,
    /** Merchant: withdrawal status + step-up confirm. */
    withdrawal: (withdrawalId: string, t: string) => `${b}/w/${withdrawalId}?t=${t}`,
    /** Merchant: confirm a pending action (refund, withdrawal, auto-withdraw). */
    confirm: (actionId: string, t: string) => `${b}/confirm/${actionId}?t=${t}`,
  };
}

export type Links = ReturnType<typeof links>;
