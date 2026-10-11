// iMessage App cards (Photon Spectrum `app()` / `edit()`), owned by Sahith.
// Builders (pure): packages/imessage-apps/src/builders.ts → CardSpec (URL + options).
// Presenter (side effects): packages/imessage-apps/src/presenter.ts → sends / edits cards through the
// Spectrum instance the agent runtime (Saran) creates and injects. Works for merchants AND customers.
// Pages the card URLs open: the minimal web app, apps/web/app/** (Sahith). Same page in Safari or inside Messages.
// On WhatsApp there are no app cards: the presenter sends `fallbackText` + the URL, and edits become new
// messages only when `updateText` is set.

import type { Invoice, Merchant, MenuItem, Payment, PendingAction, Recipient, Withdrawal } from "./domain";

export type CardKind =
  | "setup" // merchant: shop setup mini-app (name, category, menu)        → /setup?t=
  | "bank" // merchant: secure bank details form                          → /bank?t=
  | "shop" // merchant: minimal "my shop" page                             → /shop?t=
  | "menu" // anyone: the shop's menu / fixed-QR page                      → /m/<id>
  | "invoice" // customer: pay an invoice inside Messages (Apple Pay)       → /pay/<code>
  | "receipt" // customer: receipt                                         → /r/<paymentId>
  | "sale" // merchant: new sale notification (edited on refund)            → /r/<paymentId>?view=merchant&t=
  | "withdrawal" // merchant: live withdrawal status                       → /w/<id>?t=
  | "confirm"; // merchant: confirm a refund / withdrawal / setting        → /confirm/<actionId>?t=

export interface CardSpec {
  kind: CardKind;
  /** Stable identity for edit-in-place, e.g. "withdrawal:wd_123", "setup:ahseng", "invoice:inv_9". */
  key: string;
  /** Absolute https URL. Includes `v=<state>` so iMessage refetches the preview when the state changes. */
  url: string;
  /** Ask iMessage to render the live web UI (Spectrum iMessage App) instead of the static preview. */
  live: boolean;
  /** One sentence for WhatsApp / SMS / logs, e.g. "Ah Seng Chicken Rice sent you a request for S$12.00". */
  fallbackText: string;
  /** On channels without edit-in-place, send this as a new message when the card is updated. Omit = stay quiet. */
  updateText?: string;
}

export interface CardBuilders {
  setup(v: { merchant: Merchant; menu: MenuItem[]; sessionToken: string }): CardSpec;
  bank(v: { merchant: Merchant; sessionToken: string }): CardSpec;
  shop(v: { merchant: Merchant; sessionToken: string }): CardSpec;
  menu(v: { merchant: Merchant; menu: MenuItem[] }): CardSpec;
  invoice(v: { invoice: Invoice; merchant: Merchant }): CardSpec;
  receipt(v: { payment: Payment; merchant: Merchant }): CardSpec;
  sale(v: { payment: Payment; merchant: Merchant; sessionToken: string }): CardSpec;
  /** Pass `actionId` + `confirmToken` when the withdrawal needs the web step-up; the page reads them as `?a=` and `?c=`. */
  withdrawal(v: {
    withdrawal: Withdrawal;
    merchant: Merchant;
    destinationLabel: string;
    sessionToken: string;
    actionId?: string;
    confirmToken?: string;
  }): CardSpec;
  confirm(v: { action: PendingAction; merchant: Merchant; summary: string; confirmToken: string }): CardSpec;
}

export interface SentMessage {
  /** Spectrum message id. A 👍 tapback targeting it can confirm a pending action. */
  messageId: string;
  edited: boolean;
}

export interface CardPresenter {
  /** New card bubble. Remembers the handle under spec.key. WhatsApp invoices to new contacts use the approved template. */
  send(to: Recipient, spec: CardSpec): Promise<SentMessage>;
  /** Edit the bubble with spec.key in place (iMessage). Unknown handle → send new. WhatsApp → `updateText` or nothing. */
  update(to: Recipient, spec: CardSpec): Promise<SentMessage | null>;
  /** Plain text. */
  text(to: Recipient, body: string): Promise<{ messageId: string }>;
  /** PNG image (QR codes, stickers). */
  image(to: Recipient, png: Uint8Array, name: string, caption?: string): Promise<{ messageId: string }>;
}
