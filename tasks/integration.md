# Integration log (append-only, everyone)

## Gates

| Gate | Target | Owner(s) | Status | Evidence (command output, tx link, screenshot) |
|---|---|---|---|---|
| G0 · Setup (+ WhatsApp template submitted) | 11:50 | all | [ ] | |
| G1 · `settle:demo` delivers 12.50 XSGD | 12:30 | Nithya | [ ] | |
| G2 · Setup card on phone M, edited in place | 13:00 | Sahith + Saran | [ ] | |
| G2b · Onboarding by chat → live shop + sticker | 13:45 | Saran + Sahith + Nithya | [ ] | |
| G3 · Invoice by text → Apple Pay → paid, deployed | 14:30 | all | [ ] | |
| G3b · One-time QR paid with the BNB Chain wallet | 15:00 | Nithya + Sahith | [ ] | |
| G4 · Bank added → withdrawal to "In your bank" · refund via 👍 · voice | 15:30 | Nithya + Saran + Sahith | [ ] | |
| G5 · Freeze + 3 rehearsals | 16:00 | all | [ ] | |
| Video recorded | 16:30 | Sahith | [ ] | |
| Submitted | 17:00 | Sahith | [ ] | |

### G0 checklist
- [ ] `pnpm i && pnpm check` green on `main`
- [ ] `.env` complete on all laptops (docs/09)
- [ ] Supabase schema applied
- [ ] Photon "hello" on phones M and C
- [ ] Stripe test keys work (`stripe listen` connected)
- [ ] `pnpm seed` printed the AMM link
- [ ] `rove_invoice` WhatsApp template submitted

## Check-in answers

| Question | Asked by | Answer |
|---|---|---|
| Pre-written specs/scaffolding allowed? | Sahith | |
| YZi: does BNB pay-in + XRPL settlement qualify? | Sahith | |
| Ripple: Credentials on testnet? Testnet RLUSD issuer? | Nithya | |

## First-hour experiments

| Experiment | Owner | Result |
|---|---|---|
| **Photon shared-pool allowlist** | Sahith | First G2 run failed: `PERMISSION_DENIED: Target not allowed for this project`. Free/Pro plans only message numbers added under **Users** in the Photon dashboard (or `photon spectrum users add`). Add every demo phone (merchant, customer, teammates). Business plan (dedicated line) removes the limit. |
| `app(url, { live: true })` renders our page live? | Sahith | |
| Apple Pay available inside the card web view? | Sahith + Nithya | |
| Tapback on an app card → `reaction.target.id` = card id? | Sahith + Saran | |
| `customizedMiniApp` static layout without our extension? | Sahith | |
| `poll()` + `poll_option` votes work on our plan? | Saran | |
| `.m4a` arrives as a voice bubble? | Saran | |
| WhatsApp template approved? | Saran | |

## Requests (need something in another owner's paths? add a row; owner replies)

| Time | From | To | Request | Status |
|---|---|---|---|---|
| pre-G0 | Nithya | Sahith | `/pay` + `/m`: show `CheckoutRes.charge` as the big amount ("US$9.72 · S$12.50 at 1.2860 · no card FX fees"), add a USD/SGD toggle, and send `payCurrency` from the browser locale; receipt shows `PaymentStatusRes.charge`. Why: payments-stripe.md §1a (card leg never converts) | open |
| pre-G0 | Nithya | Saran | `pay_shop` / invoices: nothing to change (checkout uses the payer phone's country). Pitch line: "pay in your own currency, merchant gets theirs, no card FX" instead of "Rove converts" | open |

## Contract changes (mirror of docs/02 changelog)

| Time | Change | Approved by |
|---|---|---|
| | | |
