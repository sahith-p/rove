# Sahith: minimal web app, iMessage App cards (Photon App API), QR images, Privy, demo

Specs: [web-app](../docs/specs/web-app.md) · [imessage-apps](../docs/specs/imessage-apps.md) · [invoicing-and-qr](../docs/specs/invoicing-and-qr.md) · [withdrawals](../docs/specs/withdrawals.md) (pages) · [bnb-lane](../docs/specs/bnb-lane.md) (button) · [design](../docs/specs/design.md) · [demo](../docs/07-demo.md)

## Human (you)

- [x] **H1 (pre-G0)** GitHub repo + invites + CODEOWNERS handles · Vercel project (root `apps/web`) · Privy app (BSC testnet 97, Vercel domain) + demo customer login · `TOKEN_SECRET` · [docs/09](../docs/09-services-and-keys.md)
- [ ] **H2 (11:30)** Ask organizers about scaffolding; ask YZi about BNB + XRPL. Log in `integration.md`.
- [~] **H3 (12:45–13:00)** Gate **G2** (cards reach phone M; edit-in-place visual check pending) with Saran on phone M; run the first-hour experiments (live render, Apple Pay inside the card, tapback target, customizedMiniApp).
- [ ] **H4 (14:30)** Gate **G3** on phones M + C.
- [ ] **H5 (16:00–16:45)** Rehearse 3×, record, submit (docs/07).

## Lane A: Customer pay pages

### SH-A1 · Web shell + shared components · 30 min
- [x] merged
- **Depends:** G0 · **Unblocks:** all pages
- **Paths:** `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/components/**`, `apps/web/lib/ui/**`
- **Do:** CSS approach (Tailwind or CSS modules), components: Button, Amount, LineItems, StatusStepper, MerchantHeader (name + ✓ verified). `lib/ui/session.ts`: read `t` server-side (`verifyToken<MerchantSessionPayload>`), pass it as `x-rove-session`. Deploy to Vercel.
- **Done when:** `pnpm --filter web build` passes; Vercel serves the shell.

### SH-A2 · `/pay/[code]` on mocks · 45 min
- [x] merged
- **Depends:** SH-A1
- **Paths:** `apps/web/app/pay/**`
- **Do:** Fetch `InvoicePublicRes` (fixtures until NI-B4); same page for `invoice`, `one_time_qr` and `pay_request` codes; every state in web-app.md (open, paying, paid, expired, already paid, cancelled); mobile width; works inside Messages.
- **Done when:** All states render from fixtures at 375px.

### SH-A3 · Apple Pay (Stripe Express Checkout) · 60 min
- [ ] status
- **Depends:** SH-A2, NI-B2 merged
- **Paths:** `apps/web/app/pay/**`, `apps/web/components/checkout/**`
- **Do:** `POST /api/checkout {target:{source:"invoice",code}, method:"card"}` → Elements + `ExpressCheckoutElement` → `confirmPayment({ redirect: "if_required" })` → poll `GET /api/payments/:id` → "Paid ✓" + "View on XRPL". "Open in Safari to pay" fallback if Apple Pay isn't offered inside Messages.
- **Done when:** On phone C, an invoice card → Apple Pay → "Paid ✓" (test card 4242 also works).

### SH-A4 · "Pay with a BNB Chain wallet" (Privy) · 60 min
- [ ] status
- **Depends:** SH-A3, NI-C6 merged
- **Paths:** `apps/web/components/privy/**`, `apps/web/app/pay/**`, `apps/web/app/m/**`
- **Do:** `PrivyProvider` (embedded wallets, BSC testnet 97). Button → `POST /api/checkout {method:"bnb"}` → `transfer(depositAddress, units)` from the embedded wallet (viem `encodeFunctionData`); fallback: address + amount + EIP-681 QR. Poll status.
- **Done when:** Gate **G3b**.

### SH-A5 · `/m/[merchantId]` fixed-QR page · 45 min
- [~] agent (in progress)
- **Depends:** SH-A3
- **Paths:** `apps/web/app/m/**`
- **Do:** `ShopPublicRes` → menu grid with +/- and a "pay another amount" field → total → same pay buttons (`target.source = "fixed_qr"`); optional "Text me a receipt" phone field.
- **Done when:** Scanning the sticker → pick 2 items → Apple Pay → paid.

### SH-A6 · `/r/[paymentId]` receipt + sale view · 25 min
- [x] merged
- **Depends:** SH-A2
- **Paths:** `apps/web/app/r/**`
- **Do:** Receipt (merchant, items, total, method, time, XRPL link); `?view=merchant&t=` adds "Refund" (→ tells the merchant to ask Rove). Refunded state.
- **Done when:** Renders settled + refunded from fixtures and live data.

## Lane B: iMessage App API (cards, presenter, QR)

### SH-B1 · Card builders · 40 min
- [x] merged
- **Depends:** G0
- **Paths:** `packages/imessage-apps/src/builders.ts`, `packages/imessage-apps/src/*.test.ts`
- **Do:** All 9 kinds per imessage-apps.md §3 using `links()`, `v=<state>`, fallbackText, updateText rules.
- **Done when:** Unit tests: deterministic URLs, `v` changes per state, updateText only on the listed states.

### SH-B2 · `/setup` shop mini-app · 60 min
- [x] merged
- **Depends:** SH-A1, NI-B5 (fixtures until merged)
- **Paths:** `apps/web/app/setup/**`
- **Do:** Name, category, menu editor (add/edit/remove rows, price), save → `PUT /api/me/shop` + `PUT /api/me/menu`. Built to live inside the Messages card.
- **Done when:** Saving inside Messages updates the DB and the agent edits the setup card ("4 items ✓").

### SH-B3 · Preview images · 30 min
- [~] agent (in progress)
- **Depends:** SH-A2, SH-B2
- **Paths:** `apps/web/app/**/opengraph-image.tsx`, `generateMetadata` in each page
- **Do:** `next/og` image per page + state: "S$12.50 · Paid ✓", "Withdrawal · In your bank ✓", "Ah Seng Chicken Rice · 4 items".
- **Done when:** Static card previews show amount + status.

### SH-B4 · Presenter + G2 smoke + experiments · 75 min
- [x] merged
- **Depends:** SH-B1 · needs `SPECTRUM_*` from Saran
- **Paths:** `packages/imessage-apps/src/presenter.ts`, `packages/imessage-apps/scripts/card-smoke.ts`
- **Do:** imessage-apps.md §5: iMessage `app()` / `edit()`, WhatsApp text fallback + `rove_invoice` template for invoices, `text()`, `image()`; per-recipient send queue; `card-smoke` script. Run + log the four first-hour experiments.
- **Done when:** Gate **G2**; experiment results in `integration.md`.

### SH-B5 · `/confirm/[actionId]` page · 30 min
- [x] merged
- **Depends:** SH-A1, SA-A3 merged
- **Paths:** `apps/web/app/confirm/**`
- **Do:** Summary + Confirm / Cancel → `POST /api/actions/:id/confirm { token }`; show returned status; disable after tap; poll until done/expired.
- **Done when:** Tapping Confirm inside Messages executes the refund.

### SH-B6 · QR images · 40 min
- [x] merged
- **Depends:** G0
- **Paths:** `packages/imessage-apps/src/qr.ts`
- **Do:** `qrPng(url)` and `stickerPng({ name, url, shopCode, roveNumber, verified })` (shop name, QR, "✓ Verified on XRPL", "Scan to pay · or text *pay ahseng* to +1 555…"). One-time QR images also print the typed code (`K7Q2MX`) under the QR. Export from the package index.
- **Done when:** Test decodes the PNG back to the URL; the printed sticker scans on phone C.

## Lane C: Merchant pages + demo

### SH-C1 · `/bank` secure form · 45 min
- [x] merged
- **Depends:** SH-A1, NI-B6 (fixture until merged)
- **Paths:** `apps/web/app/bank/**`
- **Do:** Tabs: PayNow UEN / PayNow mobile / bank account (SG bank picker) + holder name → `POST /api/me/bank-accounts` → show resolved name + last 4. Expired-link state (15 min). Never echo full numbers after submit.
- **Done when:** Saving shows "DBS ••••1234 (AH SENG FOOD PTE LTD) ✓" and the agent confirms in chat.

### SH-C2 · `/w/[withdrawalId]` withdrawal page · 45 min
- [x] merged
- **Depends:** SH-A1, NI-B6
- **Paths:** `apps/web/app/w/**`
- **Do:** Stepper *Requested → On XRPL → Sent to bank → In your bank* with tx link + FAST ref; **step-up Confirm button** when `needsStepUp` (posts to `/api/actions/:id/confirm` with the confirm token from the URL); failed / returned states; "Bank payout simulated (demo)" footer. Poll every 1s.
- **Done when:** A first withdrawal can be confirmed here and walks to "In your bank".

### SH-C3 · `/shop` minimal page · 40 min
- [x] merged
- **Depends:** SH-A1, NI-B5
- **Paths:** `apps/web/app/shop/**`
- **Do:** `GET /api/me`: balance (available / held + "Ledger ✓ matches XRPL"), last 10 payments, open invoices, contacts, menu (read-only, "Edit" → the agent sends the setup card).
- **Done when:** Numbers match the DB after a sale and a withdrawal.

### SH-C4 · Demo kit · 45 min (after G4)
- [ ] status
- **Paths:** `docs/07-demo.md`, `README.md` (submission section)
- **Do:** Pre-record the onboarding replay; print the sticker; stage backups; README "what's real vs simulated" + diagram; record the video.
- **Done when:** Video uploaded, submission filled.
