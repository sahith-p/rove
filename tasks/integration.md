# Integration log (append-only, everyone)

## Gates

| Gate | Target | Owner(s) | Status | Evidence (command output, tx link, screenshot) |
|---|---|---|---|---|
| G0 · Setup (+ WhatsApp template submitted) | 11:50 | all | [ ] | |
| G1 · `settle:demo` delivers 12.50 XSGD | 12:30 | Nithya | [x] | delivered exactly 12.50 XSGD to ahseng: [tx BEBA82CD…](https://testnet.xrpl.org/transactions/BEBA82CDEBA86490C3FFC2A92F28A4D33F9494D9D85233460D314B99962EF977). Live quote S$12.50 → US$9.73 (rate 1.2846) |
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
| Ripple: Credentials on testnet? Testnet RLUSD issuer? | Nithya | Credentials: **yes**, enabled on testnet (CredentialCreate + CredentialAccept tesSUCCESS, NI-A4). RLUSD issuer: not asked yet |

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
| 14:20 | Sahith | Nithya | Add optional fields to `PaymentStatusRes` for the receipt page: `createdAt`, `refunded` (Money), `payerName`, `merchantVerified`. The page already reads them when present (SH-A6). | **done in contract** (Nithya): all four optional on `PaymentStatusRes`; NI-B4 fills them. `payerName` only when the request carries a valid `sale` session for that payment (the route is public) |
| pre-G0 | Nithya | Sahith | `/pay` + `/m`: show `CheckoutRes.charge` as the big amount ("US$9.72 · S$12.50 at 1.2860 · no card FX fees"), add a USD/SGD toggle, and send `payCurrency` from the browser locale; receipt shows `PaymentStatusRes.charge`. Why: payments-stripe.md §1a (card leg never converts) | open |
| pre-G0 | Nithya | Sahith | Demo script + pitch (docs/07): use the fee lines in payments-stripe.md §8 "Saying it to judges"; lead the BNB beat with "no card fees at all". Don't claim everyone pays less | open |
| pre-G0 | Nithya | Saran | `@rove/db` interface is now defined (`packages/db/src/index.ts`: `Db`, `getDb()`; tests use `createTestDb()` from `@rove/db/testing`, an in-process Postgres). Build agent tools against it. Env: `DATABASE_URL` replaces `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` on the agent too | open |
| pre-G0 | Nithya | Sahith | Vercel env: no signing secrets (`XRPL_*_SEED`, `WALLET_ENCRYPTION_KEY`, `BSC_DEPOSIT_MNEMONIC`); add `DATABASE_URL`, `XRPL_TREASURY_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS`, `BSC_DEPOSIT_XPUB` (docs/09). `MeRes.reconciled` (optional) is the `/shop` "Ledger ✓ matches XRPL" flag, named to match what `/shop` already reads | open |
| NI-C1 | Nithya | Saran | Worker is up (`apps/worker`, :4001). `POST /internal/merchants` works now on the mock engine: idempotent, upserts the onboarding draft, emits `merchant.live` once; 409 `shop_id_taken` if the id belongs to another phone. Errors from every worker route are `{ error, message }` (422 by default): **say `message` to the merchant as is**. Events: `/internal/events` must return 2xx to mark delivered; 4xx isn't retried; retries/boot replays reuse the same envelope id (dedupe on it) | open |
| G1 | Nithya | Sahith | `apps/web` now depends on `@rove/xrpl` (added to package.json + next.config transpilePackages; co-owned files, small change). With `USE_MOCK_SETTLEMENT=0` the web quotes from the real testnet AMM (read-only, no seeds). Vercel needs `XRPL_WSS`, `XRPL_USD_ISSUER`, `XRPL_SGD_ISSUER`, `XRPL_TREASURY_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS` (public values; Nithya shares them) | open |
| A5 | Nithya | Sahith | New pay method **`ausd`** (Agora AUSD track): a third button "Pay with AUSD · no gas" on `/pay` and `/m`. `POST /api/checkout {method:"ausd"}` returns `ausd` = EIP-712 domain + ERC-3009 `authorization`; the Privy embedded wallet (Base Sepolia 84532) signs `TransferWithAuthorization` with its own address as `from` (no gas needed), then `POST /api/ausd/authorize {paymentId, from, signature}`; poll the payment as usual. I added `ausd` to `METHOD_LABEL` in `app/r/[paymentId]/_preview.ts` (one line) so the contract change typechecks. Backend lands from the AUSD agent; spec: docs/specs/ausd-lane.md | open |
| A5 | Nithya | Saran | Optional: `pay_shop`/invoice copy can mention "pay with AUSD, no gas". Nothing required | open |
| NI-B6 | Nithya | Sahith + Saran | **/w step-up button can't work as wired:** the page reads `?a=<actionId>&c=<confirmToken>`, but `links.withdrawal()` / `cards.withdrawal()` only build `/w/<id>?t=…`, and `WithdrawalRes` has neither (`withdrawals.action_id` is set only at approval). Proposal: the agent (which knows both at propose time) appends `&a=…&c=…` to the withdrawal card URL; no contract change. Needs Saran + Sahith to agree | **done (Sahith):** `cards.withdrawal()` now takes optional `actionId` + `confirmToken` and adds `&a=&c=`; Saran passes them when `needsStepUp` |
| NI-B6 | Nithya | Sahith | /bank (in progress in the redesign): (1) copy says "Replaces your current account", but the backend keeps the first account as default (spec §2); change the copy or ask me for a set-default route. (2) `errorText()` shows `json.error` (a code like `account_not_verified`); show `json.message`, which is written for merchants. (3) partner failure comes back as **422** `{error, message}`, not 200 `status:"failed"` | open |
| B2–B5, C2 | Nithya | Sahith + Saran | Live on main now: `POST /api/checkout` (card in the payer's currency, reuses the same payment across currency-toggle switches, ausd/bnb return 501 until their lanes land), Stripe webhook (Apple Pay detection, duplicate-invoice auto-refund), `GET /api/invoices/:code`, `/api/shops/:id`, `/api/payments/:id` (payerName only with a matching sale session), `GET /api/me` (+ `reconciled`), `PUT /api/me/shop`, `PUT /api/me/menu`, worker settle poller (emits `payment.settled` with `firstSale`). **Sahith:** the pay, shop, receipt, setup and /shop pages can run on the real API instead of fixtures. **Saran:** `payment.settled` events now come from real settlements | open |
| B4/B5 | Nithya | Sahith | Fixed on main: removing an item in /setup now deletes it (hiding is `active: false`), so it no longer comes back as "Hidden"; receipts opened from /shop with the merchant's `shop` token now show the payer's name. `/m`: 409 also means `merchant_not_live`; `bnb`/`ausd` return 501 until those lanes land | open |
| B4/B5 | Nithya | Saran | `create_one_time_qr` / `create_invoice` with a free amount must pass one line `{menuItemId: null, name: "Payment", qty: 1, unit: amount}`: `createInvoice` checks lines add up to the total (spec §4) | open |
| C5 | Nithya | Saran | Refunds (`POST /internal/refunds`) are live. `InternalRefundRes.status: "pending"` means in progress / under review, not done; wait for `refund.completed`. For bnb/ausd payments, `refund.completed` covers the XRPL + ledger part; the token return to the customer is a manual step (say "refund on its way", not "refunded to your wallet") | open |
| CUR | Nithya | Sahith + Saran | **Currency registry** (`packages/shared/src/currencies.ts`): `Currency` is now USD, SGD, EUR (any currency with a stablecoin on XRPL; spec docs/specs/corridors.md). Symbols/decimals come from the registry (`format()` shows €). **Saran:** `InternalCreateMerchantReq.currency` accepts any merchant currency (SGD stays the default for the demo); onboarding can ask the country later. **Sahith:** nothing breaks; checkout answers 400 `currency_not_supported` for a payer currency it can't charge yet (EUR charging lands in the corridors Phase B) | open |
| pre-G0 | Nithya | Saran | `pay_shop` / invoices: nothing to change (checkout uses the payer phone's country). Pitch line: "pay in your own currency, merchant gets theirs, no card FX" instead of "Rove converts" | open |

## Contract changes (mirror of docs/02 changelog)

| Time | Change | Approved by |
|---|---|---|
| | | |
