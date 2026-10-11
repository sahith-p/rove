# Spec · Invoices, QR codes, menus, contacts

Owners: **Saran** (agent tools) · **Nithya** (DB helpers, invoice + checkout APIs) · **Sahith** (pay pages, QR images, invoice card) · Tasks: SA-B2, NI-B1, NI-B2, NI-B4, SH-A2, SH-A5, SH-B6

## 1. Every way to get paid

| # | Who starts | Says / does | What exists | Customer pays via | Amount | Uses | Expiry |
|---|---|---|---|---|---|---|---|
| 1 | Merchant | "invoice Maya 2 chicken rice" / "invoice +65 9123 4567 for 10" | `invoice` with `to` | pay card texted to them (iMessage card / WhatsApp template) | fixed | 1 | 7 days |
| 2 | Merchant | "code for 6.50" / "QR for 2 chicken rice" | `one_time_qr` | **scan the QR, or text the code** (`K7Q2MX`) to Rove | fixed | 1 | 30 min |
| 3 | Merchant | "send my QR sticker" | nothing new: shop link `/m/<shop code>` | **scan the sticker, or text "pay ahseng 6.50"** | customer picks items / types amount | ∞ | never |
| 4 | Customer | "pay ahseng 6.50" · "pay Ah Seng 2 chicken rice" · "pay +65 9123 4567 10" | `pay_request` with `to` = the customer | pay card in their own thread | from the customer (menu prices from the DB) | 1 | 1 hour |
| 5 | Customer | texts `K7Q2MX` | (the existing one-time code or invoice) | pay card in their thread | fixed | — | — |
| 6 | Customer | "what do I owe?" / "pay it" | (invoices sent to their number) | pay card re-sent | fixed | — | — |

All of them end in the same `POST /api/checkout` → Stripe / BNB → settle. The pay page treats `invoice`, `one_time_qr` and `pay_request` codes identically.

**Codes:** payment codes are 6 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O/1/I). The **shop code** is the merchant id slug (`ahseng`), printed on the sticker with the Rove number: "Scan, or text *pay ahseng* to +1 555…". A message that is *only* a payment code (`PAYMENT_CODE_RE`) skips Claude and goes straight to `pay_code`.

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

## 7. Customer side (texting Rove)

- **Pay by code:** a customer texts `K7Q2MX` → `pay_code` → open + unexpired → pay card. Paid / expired / unknown → a one-line answer.
- **Pay a shop by text:** "pay ahseng 6.50" → `pay_shop` resolves the shop by **shop code**, then **merchant phone**, then **name** (fuzzy; ask if ambiguous). Items are priced from the shop's menu; a free amount must be > 0 and ≤ S$500. It creates a `pay_request` invoice (`to` = the customer, 1-hour expiry) and sends the pay card. No amount or items → it sends the shop's menu card.
- **What do I owe:** `my_open_invoices` = open invoices where `to_phone` = their phone; "pay it" → `pay_invoice` re-sends the card.
- **Receipts:** `my_receipts` = payments whose payer phone = their phone.
- **Stretch:** a customer sends a *photo* of a Rove QR → decode it (`jsQR` on the image attachment) → treat it like a typed code / shop code.
- A customer never sees anyone else's invoices: lookups are by their own phone or by an unguessable code.
- **Merchants are customers too:** a merchant's phone gets the customer tools as well, so Ah Seng can text "pay kopi-uncle 3.20" or "what do I owe?".
