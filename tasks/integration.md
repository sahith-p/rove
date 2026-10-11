# Integration log (append-only, everyone)

## Critical path to done (handoff, updated 15:45 by Sahith)

Every open gate (G2b, G3, G3b, G4) waits on items 1 to 3 below. Details are in the Requests rows below.

**Saran: real agent (blocks real cards)**
- [ ] 1. `apps/agent/src/store/db.ts`: replace the throwing `createDbStore()` stub with an adapter over `createDb(DATABASE_URL)` from `@rove/db`. 34 of the 40 `Store` methods already exist there.
- [ ] 2. `apps/agent/src/env.ts`: `offline: !env.DATABASE_URL`, not `SUPABASE_URL`, since nobody sets `SUPABASE_URL`.
- [ ] 3. Deploy the agent to Railway with `USE_MOCK_CARDS=0`, `PHOTON_*`, `DATABASE_URL`, `PUBLIC_BASE_URL=https://rove-topaz.vercel.app`, `WORKER_URL`, `INTERNAL_SECRET`, `TOKEN_SECRET` (same as Vercel), `ANTHROPIC_API_KEY`. Share `AGENT_URL`. No redeploys during the demo.
- [ ] 4. Mark finished SA tasks `[x]` in tasks/saran.md.

**Nithya: worker + data**
- [ ] 1. Deploy the worker to Railway with `USE_MOCK_SETTLEMENT=0`, `AGENT_URL`, `DATABASE_URL`, `INTERNAL_SECRET`, XRPL seeds. Share `WORKER_URL`. Without it Stripe payments stop at `authorized`: no settle, no sale or receipt card.
- [ ] 2. Add the 6 missing `@rove/db` helpers. Needed for 👍 confirms: `setActionMessageIds`, `findActionByMessageId`, `finishAction`, `findActionByRef`. Can wait: `invoicesDueForReminder`, `markInvoiceReminded`.
- [ ] 3. Stripe: card-only payment methods (no redirect methods) + the checkout-reuse question (15:15 row). Add `rove-topaz.vercel.app` as an Apple Pay domain (15:05 row).
- [x] 4. Send Sahith `NEXT_PUBLIC_PRIVY_APP_ID` (got it, set on Vercel) (15:05 row) so SH-A4 (AUSD/BNB button) can start.

**Sahith: web + cards**
- [ ] 1. Merge + deploy the redesign: minimal, no-scroll `card=1` layouts on every page.
- [ ] 2. Set `NEXT_PUBLIC_DEMO_FIXTURES=0` on Vercel (real data only) after the redesign deploy.
- [ ] 3. G2b with Saran once the agent is live: the agent sends an invoice card to phone M.
- [ ] 4. SH-A4 Privy button (after item 4 of Nithya's list). SH-C4 demo script, video at 16:30, repo public, submit by 17:00.

**Then all three:** one real loop on phone M: text "invoice +19259156406 2 chicken rice" → card arrives → Apple Pay on /pay → settles on XRPL → sale card. Then G4: add bank → withdraw → 👍 → "In your bank".

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
| 15:40 | Sahith | Saran | **Correction to my 15:18 note, and the real blocker for real cards:** `apps/agent/src/store/db.ts` `createDbStore()` is still a stub that **throws** ("@rove/db helpers aren't merged yet"). They are merged now. So just flipping the offline flag would crash the agent. Write the adapter: map each `Store` method to `createDb(DATABASE_URL)` helpers, and gate offline on `DATABASE_URL`. 34 of the 40 methods exist in `@rove/db`. | open |
| 15:40 | Sahith | Nithya | `@rove/db` is missing 6 helpers the agent Store needs (requested earlier): `setActionMessageIds`, `findActionByMessageId`, `finishAction`, `findActionByRef`, `invoicesDueForReminder`, `markInvoiceReminded`. The first 4 are needed for 👍 confirmations (withdraw/refund); the reminder pair can wait. | open |
| 15:18 | Sahith | Saran | **Agent runs offline in prod as written:** `apps/agent/src/env.ts` sets `offline: !env.SUPABASE_URL`, but the team uses **`DATABASE_URL`** (Nithya's `createDb` reads it; there is no `SUPABASE_URL` in anyone's .env). So the agent silently uses the in-memory store + mock worker. Change to `offline: !env.DATABASE_URL` (or check both) and confirm `createDbStore()` passes `DATABASE_URL`. | open |
| 15:18 | Sahith | Saran | **Critical path to G2b/G3/G4:** (1) fix the offline flag above, (2) deploy the agent to Railway and share `AGENT_URL` (Nithya: worker too, share `WORKER_URL`), (3) run one real loop on phone M: text "invoice +19259156406 2 chicken rice" → invoice card arrives → pay on /pay → sale card. Cards: presenter now sends Rove-branded customized cards with `card=1` URLs; on shared lines a recipient must have texted the Rove line once. Also mark your SA tasks [x] in tasks/saran.md. | open |
| 15:15 | Sahith | Nithya | SH-A3 merged (real Stripe Express Checkout + card form on /pay and /m; test PI `pi_3UPUoY2Nmb09925b1oehQn07` succeeded → webhook → `authorized`). Asks: (1) PaymentIntent uses `automatic_payment_methods` so the card form also offers Bank/Cash App/Klarna; add `allow_redirects: "never"` or explicit `payment_method_types: ["card"]` (wallets ride on card). (2) Two checkouts for the same basket a few minutes apart got different paymentIds — check reuse (may be quote expiry). (3) Settling needs the worker running (Railway). | open |
| 15:05 | Sahith | Nithya | **Stripe Apple Pay domain:** Stripe Dashboard (test mode) → Settings → Payment method domains → add `rove-topaz.vercel.app` (prod alias). Apple Pay won't show on the real site until this is done; SH-A3 (Express Checkout) is being wired now. Reply here when done. | **done** (Nithya): `rove-topaz.vercel.app` registered in the rove sandbox (pmd_1UPUqy2N…): Apple Pay **active**, Google Pay active. Still verify the button on phone C in Safari + inside the iMessage card |
| 15:05 | Sahith | Nithya | **Privy app for the BNB + AUSD buttons (SH-A4):** create a Privy app at dashboard.privy.io → enable embedded EVM wallets (create on login), chains **BSC testnet 97** + **Base Sepolia 84532**, allowed origins `https://rove-topaz.vercel.app` + `http://localhost:3000`, email login. Create one demo customer login (Privy test account if available) and fund its wallet with tBNB + test USDT (BSC) and Base Sepolia AUSD/ETH as your lanes need. Share `NEXT_PUBLIC_PRIVY_APP_ID` (public) here or with Sahith. | open |
| 15:05 | Sahith | Nithya | **Public XRPL values for Vercel:** send `XRPL_WSS`, `XRPL_USD_ISSUER`, `XRPL_SGD_ISSUER`, `XRPL_TREASURY_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS` (+ `BSC_DEPOSIT_XPUB`, `BSC_TOKEN_ADDRESS` when ready) so Sahith can set them on Vercel and turn `USE_MOCK_SETTLEMENT=0` there. No seeds/mnemonics. | **XRPL done** (Nithya), public testnet values: `XRPL_WSS=wss://s.altnet.rippletest.net:51233` · `XRPL_USD_ISSUER=rH15tHofyKyTfoCKHx9C839K2VS55sewLg` · `XRPL_SGD_ISSUER=rwkaqG93nQBqkSqosVfqUqjLcH5hizMMJd` · `XRPL_TREASURY_ADDRESS=rDAjoXuxGgqrqfivKWpLCsqCDggaWFcXCS` · `XRPL_CREDENTIAL_ISSUER_ADDRESS=rUhv2j8yKAa8XoTMihApuUmKJcvBSP8b8f`. Also set `DATABASE_URL` on Vercel (Nithya shares it privately). `BSC_DEPOSIT_XPUB` / `BSC_TOKEN_ADDRESS` follow when NI-C6 lands; `XRPL_ISSUER_EUR` when the EUR corridor lands |
| 14:20 | Sahith | Nithya | Add optional fields to `PaymentStatusRes` for the receipt page: `createdAt`, `refunded` (Money), `payerName`, `merchantVerified`. The page already reads them when present (SH-A6). | **done in contract** (Nithya): all four optional on `PaymentStatusRes`; NI-B4 fills them. `payerName` only when the request carries a valid `sale` session for that payment (the route is public) |
| pre-G0 | Nithya | Sahith | `/pay` + `/m`: show `CheckoutRes.charge` as the big amount ("US$9.72 · S$12.50 at 1.2860 · no card FX fees"), add a USD/SGD toggle, and send `payCurrency` from the browser locale; receipt shows `PaymentStatusRes.charge`. Why: payments-stripe.md §1a (card leg never converts) | open |
| pre-G0 | Nithya | Sahith | Demo script + pitch (docs/07): use the fee lines in payments-stripe.md §8 "Saying it to judges"; lead the BNB beat with "no card fees at all". Don't claim everyone pays less | open |
| pre-G0 | Nithya | Saran | `@rove/db` interface is now defined (`packages/db/src/index.ts`: `Db`, `getDb()`; tests use `createTestDb()` from `@rove/db/testing`, an in-process Postgres). Build agent tools against it. Env: `DATABASE_URL` replaces `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` on the agent too | open |
| pre-G0 | Nithya | Sahith | Vercel env: no signing secrets (`XRPL_*_SEED`, `WALLET_ENCRYPTION_KEY`, `BSC_DEPOSIT_MNEMONIC`); add `DATABASE_URL`, `XRPL_TREASURY_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS`, `BSC_DEPOSIT_XPUB` (docs/09). `MeRes.reconciled` (optional) is the `/shop` "Ledger ✓ matches XRPL" flag, named to match what `/shop` already reads | open |
| NI-C1 | Nithya | Saran | Worker is up (`apps/worker`, :4001). `POST /internal/merchants` works now on the mock engine: idempotent, upserts the onboarding draft, emits `merchant.live` once; 409 `shop_id_taken` if the id belongs to another phone. Errors from every worker route are `{ error, message }` (422 by default): **say `message` to the merchant as is**. Events: `/internal/events` must return 2xx to mark delivered; 4xx isn't retried; retries/boot replays reuse the same envelope id (dedupe on it) | open |
| G1 | Nithya | Sahith | `apps/web` now depends on `@rove/xrpl` (added to package.json + next.config transpilePackages; co-owned files, small change). With `USE_MOCK_SETTLEMENT=0` the web quotes from the real testnet AMM (read-only, no seeds). Vercel needs `XRPL_WSS`, `XRPL_USD_ISSUER`, `XRPL_SGD_ISSUER`, `XRPL_TREASURY_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS` (public values; Nithya shares them) | **done (Sahith):** set on Vercel prod + preview, `USE_MOCK_SETTLEMENT=0` there |
| A5 | Nithya | Sahith | New pay method **`ausd`** (Agora AUSD track): a third button "Pay with AUSD · no gas" on `/pay` and `/m`. `POST /api/checkout {method:"ausd"}` returns `ausd` = EIP-712 domain + ERC-3009 `authorization`; the Privy embedded wallet (Base Sepolia 84532) signs `TransferWithAuthorization` with its own address as `from` (no gas needed), then `POST /api/ausd/authorize {paymentId, from, signature}`; poll the payment as usual. I added `ausd` to `METHOD_LABEL` in `app/r/[paymentId]/_preview.ts` (one line) so the contract change typechecks. Backend lands from the AUSD agent; spec: docs/specs/ausd-lane.md | open |
| A5 | Nithya | Saran | Optional: `pay_shop`/invoice copy can mention "pay with AUSD, no gas". Nothing required | open |
| NI-B6 | Nithya | Sahith + Saran | **/w step-up button can't work as wired:** the page reads `?a=<actionId>&c=<confirmToken>`, but `links.withdrawal()` / `cards.withdrawal()` only build `/w/<id>?t=…`, and `WithdrawalRes` has neither (`withdrawals.action_id` is set only at approval). Proposal: the agent (which knows both at propose time) appends `&a=…&c=…` to the withdrawal card URL; no contract change. Needs Saran + Sahith to agree | **done (Sahith):** `cards.withdrawal()` now takes optional `actionId` + `confirmToken` and adds `&a=&c=`; Saran passes them when `needsStepUp` |
| NI-B6 | Nithya | Sahith | /bank (in progress in the redesign): (1) copy says "Replaces your current account", but the backend keeps the first account as default (spec §2); change the copy or ask me for a set-default route. (2) `errorText()` shows `json.error` (a code like `account_not_verified`); show `json.message`, which is written for merchants. (3) partner failure comes back as **422** `{error, message}`, not 200 `status:"failed"` | open |
| B2–B5, C2 | Nithya | Sahith + Saran | Live on main now: `POST /api/checkout` (card in the payer's currency, reuses the same payment across currency-toggle switches, ausd/bnb return 501 until their lanes land), Stripe webhook (Apple Pay detection, duplicate-invoice auto-refund), `GET /api/invoices/:code`, `/api/shops/:id`, `/api/payments/:id` (payerName only with a matching sale session), `GET /api/me` (+ `reconciled`), `PUT /api/me/shop`, `PUT /api/me/menu`, worker settle poller (emits `payment.settled` with `firstSale`). **Sahith:** the pay, shop, receipt, setup and /shop pages can run on the real API instead of fixtures. **Saran:** `payment.settled` events now come from real settlements | open |
| B4/B5 | Nithya | Sahith | Fixed on main: removing an item in /setup now deletes it (hiding is `active: false`), so it no longer comes back as "Hidden"; receipts opened from /shop with the merchant's `shop` token now show the payer's name. `/m`: 409 also means `merchant_not_live`; `bnb`/`ausd` return 501 until those lanes land | open |
| B4/B5 | Nithya | Saran | `create_one_time_qr` / `create_invoice` with a free amount must pass one line `{menuItemId: null, name: "Payment", qty: 1, unit: amount}`: `createInvoice` checks lines add up to the total (spec §4) | open |
| C5 | Nithya | Saran | Refunds (`POST /internal/refunds`) are live. `InternalRefundRes.status: "pending"` means in progress / under review, not done; wait for `refund.completed`. For bnb/ausd payments, `refund.completed` covers the XRPL + ledger part; the token return to the customer is a manual step (say "refund on its way", not "refunded to your wallet") | open |
| CUR | Nithya | Sahith + Saran | **Currency registry** (`packages/shared/src/currencies.ts`): `Currency` is now USD, SGD, EUR (any currency with a stablecoin on XRPL; spec docs/specs/corridors.md). Symbols/decimals come from the registry (`format()` shows €). **Saran:** `InternalCreateMerchantReq.currency` accepts any merchant currency (SGD stays the default for the demo); onboarding can ask the country later. **Sahith:** nothing breaks; checkout answers 400 `currency_not_supported` for a payer currency it can't charge yet (EUR charging lands in the corridors Phase B) | open |
| C4 | Nithya | Saran | Withdrawals are live (`POST /internal/withdrawals`, `/execute`). (1) **Step-up isn't enforced by the worker** (execute only gets `actionId`): for `needsStepUp` withdrawals, only call execute after a `via: "web"` confirmation. (2) An execute that hits `insufficient_funds` returns 422 *and* emits `withdrawal.updated failed`; send one message, not two. (3) Expired/cancelled withdrawal actions: the worker now cancels stale `requested` withdrawals itself (NI-C7), so you don't have to | open |
| AUSD | Nithya | Sahith | **AUSD button is ready on the backend.** Flow: `POST /api/checkout {method:"ausd"}` → `ausd.domain` + `ausd.authorization` → wallet `signTypedData` of `TransferWithAuthorization` (EIP-712 domain name "Agora Dollar", version "1", Base Sepolia 84532; `from` = the payer's address) → `POST /api/ausd/authorize {paymentId, from, signature}` → poll the payment. No gas needed. Works with Privy **or** any injected wallet (MetaMask). Spec: docs/specs/ausd-lane.md | open |
| Privy | Nithya | Sahith | Privy dashboard isn't loading for Nithya yet. Please add an injected-wallet (MetaMask) fallback for the BNB + AUSD buttons so the demo doesn't depend on Privy. When Privy works: `PrivyProvider` config `embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } }`, `supportedChains: [bscTestnet, baseSepolia]`; the App ID comes from Nithya | open |
| CUR | Nithya | Sahith + Saran | EUR corridor live on testnet (demo shop `cafe-berlin`, EUR). Vercel + worker env need `XRPL_ISSUER_EUR` (public: Nithya shares it) for EUR quotes. Pages can take symbols from the registry (`format()` shows €). Full app wiring (EUR payers on checkout, EUR onboarding) is Phase B | open |
| pre-G0 | Nithya | Saran | `pay_shop` / invoices: nothing to change (checkout uses the payer phone's country). Pitch line: "pay in your own currency, merchant gets theirs, no card FX" instead of "Rove converts" | open |
| G0 | Saran | Nithya | `@rove/db` helpers the agent calls beyond the planned surface (agent port: `apps/agent/src/ports.ts` `Store`): `listLiveMerchants`, `getInvoice(id)`, `invoicesDueForReminder(createdBefore)`, `markInvoiceReminded(id)` (CAS on reminded_at null), `setActionMessageIds`, `findActionByMessageId` (any status), `finishAction(id, status, result)`, `expireActions()`, `findActionByRef(withdrawalId \| paymentId)`. Until merged the agent runs on its in-memory store (no `SUPABASE_URL`). | open |
| post-G0 | Saran | All | **WhatsApp is dropped; iMessage only.** Agent side is done (`apps/agent`, channels/agent/onboarding specs, SA-C4 cut). Contract proposal: `Channel`/`ChannelZ` → `"imessage"` only, and drop the WhatsApp notes in `packages/shared/src/{cards,domain}.ts` (docs/02 changelog). Until then `"whatsapp"` stays in the type but nothing produces it | open |
| post-G0 | Saran | Sahith | WhatsApp is dropped: `packages/imessage-apps` can lose the `waTemplates` option, WhatsApp fallbacks and their tests (the agent no longer passes `waTemplates`); drop the WhatsApp beat from docs/07-demo + imessage-apps.md, and the template item in `tasks/sahith.md` | open |
| post-G0 | Saran | Nithya | WhatsApp is dropped: once the contract change lands, `schema.sql` channel checks can be `('imessage')`; withdrawals.md YES-reply/WhatsApp lines can go | open |
| post-G0 | Saran | All | WhatsApp is dropped: shared docs still mention it (CLAUDE.md, README, docs/00, 01, 03, 04, 05, 06, 08, 09, specs/invoicing-and-qr.md) and `.env.example` still has `SPECTRUM_WHATSAPP_BUSINESS_*` + `WHATSAPP_INVOICE_TEMPLATE` (the agent no longer reads them) | open |
| post-G0 | Saran | All | Demo phones set in `packages/shared/src/mocks/fixtures.ts`: merchant (phone M) `+14708209753`, customer Maya (phone C) `+19259156406`. With Sahith's OK, `packages/imessage-apps/src/builders.test.ts` now reads the payer from `DEMO_CUSTOMER.phone` instead of the old literal | done |
| post-G0 | Saran | Nithya | FYI (Saran asked for it to unblock `pnpm check`): your tests now read the demo merchant / Maya phones from `DEMO_MERCHANT.phone` / `DEMO_CUSTOMER.phone` instead of the old `+1555555…` literals (`packages/db/src/{matching,money-path}.test.ts`, `apps/worker/src/{merchants,server}.test.ts`, `apps/worker/src/settle/testkit.ts`, `apps/web/app/api/{checkout,me/bank-accounts,stripe/webhook,withdrawals/[id]}/*.test.ts`). Test-only, no behavior change | done |

## Contract changes (mirror of docs/02 changelog)

| Time | Change | Approved by |
|---|---|---|
| | | |
