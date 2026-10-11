# Spec · Invoices, QR codes, menus, contacts

Owners: **Saran** (agent tools) · **Nithya** (DB helpers, invoice + checkout APIs) · **Sahith** (pay pages, QR images, invoice card) · Tasks: SA-B2, NI-B1, NI-B2, NI-B4, SH-A2, SH-A5, SH-B6

## 1. Three ways to get paid

| | Invoice | One-time QR | Fixed QR |
|---|---|---|---|
| Merchant says | "invoice Maya 2 chicken rice and a barley" | "QR for 6.50" / "QR for 2 chicken rice" | "send my QR sticker" |
| What exists | `invoices` row, kind `invoice`, `to` = Maya | `invoices` row, kind `one_time_qr`, no `to` | nothing new: the shop's permanent link |
| Customer gets | a message (iMessage pay card / WhatsApp template) | scans the QR the merchant shows | scans the sticker |
| URL | `/pay/<code>` | `/pay/<code>` | `/m/<merchantId>` |
| Amount | fixed (from items or amount) | fixed | customer picks menu items or types an amount |
| Use count | single (paid → closed) | single | unlimited |
| Expiry | 7 days | 30 minutes | never |

All three end in the same `POST /api/checkout` → Stripe / BNB → settle.

## 2. Menus

- `menu_items` per merchant (name unique per shop, price in SGD, active flag, sort).
- Edited by chat (`add_menu_items`, `update_menu_item`) or in the **setup card** (`/setup`, `PUT /api/me/menu`).
- Item resolution for invoices: the agent passes `{name, qty}`; `findMenuItems(merchantId, names)` does case-insensitive exact match, then prefix, then fuzzy (trigram/Levenshtein ≤ 2). No match → the tool returns the closest names and the agent asks ("Did you mean Roasted chicken rice?"). **Prices always come from the DB, never from the model.**
- `show_menu` sends the menu card (`/m/<id>`, the same page customers use).

## 3. Contacts

- Added by text (`add_contact {name, phone}`), by **sharing a contact card** into the chat (inbound `contact` content → name + first mobile number), or automatically after a payment with a payer phone.
- `create_invoice.to` takes `contactName` (resolved with the same matching as menu items) or a raw `phone`. Unknown name → the agent asks for the number.
- Channel per contact: unknown at first. On send, prefer iMessage if Photon reports the number is iMessage-reachable (`imessage(app).user(phone)` → `service`), else WhatsApp (template) if configured, else tell the merchant to show a one-time QR instead.

## 4. Creating an invoice (tool `create_invoice`)

1. Resolve the recipient (contact or phone) and the lines (menu items × qty, or a single free-amount line "Payment").
2. `total = Σ qty × unit` (money.ts). Reject > S$500 (demo cap).
3. `createInvoice` → `code = newShortCode()` (6 chars, no 0/O/1/I), `expires_at = now + 7d`.
4. Send to the customer through the presenter: `cards.invoice({ invoice, merchant })`
   - iMessage: app card (live) → `/pay/<code>`; the customer can pay **inside Messages**
   - WhatsApp: template `rove_invoice` (merchant name, amount, URL button suffix = code) when outside the 24-hour window; plain text + link inside it
5. Confirm to the merchant: "Sent to Maya ✓ S$12.50 (2× Chicken rice, 1× Barley drink)".
6. Reminders: `remind_invoice` re-sends a nudge; a sweep auto-reminds once after 24h (`reminded_at`).
7. When paid: the invoice card on the customer side is edited to "Paid ✓" (iMessage), and a receipt card follows.

## 5. One-time QR (tool `create_one_time_qr`)

Same as an invoice with `kind: one_time_qr`, no recipient, 30-minute expiry. The agent sends the merchant a **PNG** (`qrPng(links.pay(code))` from `@rove/imessage-apps`) with a caption "S$6.50 · single use · expires 3:42pm". After payment, the QR shows "Already paid" if scanned again.

## 6. Fixed QR (tool `get_fixed_qr`)

`stickerPng({ name, url: links.shop(merchantId), verified })`: a printable sticker with the shop name, QR and "✓ Verified on XRPL". `/m/<id>` shows the menu (tap to add items) and a "Pay another amount" field.

## 7. Customer side

- Customers can text Rove: "what do I owe?" (`my_open_invoices`: invoices where `to_phone` = their phone), "pay it" (`pay_invoice` re-sends the card), "my receipts".
- The pay page offers "Text me a receipt" (phone) for fixed-QR payments; invoices already know the phone.
- A customer can never see another person's invoices: lookups are by their own phone or by an unguessable code.
