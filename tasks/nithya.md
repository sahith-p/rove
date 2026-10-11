# Nithya: money movement (DB, Stripe, XRPL, ledger, withdrawals, BNB, worker)

Specs: [withdrawals](../docs/specs/withdrawals.md) · [settlement-xrpl](../docs/specs/settlement-xrpl.md) · [payments-stripe](../docs/specs/payments-stripe.md) · [invoicing-and-qr](../docs/specs/invoicing-and-qr.md) (DB side) · [bnb-lane](../docs/specs/bnb-lane.md)

## Human (you)

- [~] **H1 (pre-G0)** done: Stripe sandbox keys, Supabase project `rove` + schema, `INTERNAL_SECRET`, `WALLET_ENCRYPTION_KEY`. Left: Railway, BNB faucet, `BSC_DEPOSIT_MNEMONIC`. · Stripe test keys · Supabase + run `packages/db/schema.sql` · Railway (worker + agent services) · BNB testnet faucet · `INTERNAL_SECRET`, `WALLET_ENCRYPTION_KEY`, `BSC_DEPOSIT_MNEMONIC` · [docs/09](../docs/09-services-and-keys.md)
- [~] **H2 (11:30)** Credentials: enabled on testnet (verified in NI-A4). RLUSD testnet issuer: still to ask. · Ripple table: Credentials on testnet? testnet RLUSD issuer? Log answers.
- [x] **H3 (12:00)** done via the Stripe API: Apple Pay active on rove-topaz.vercel.app · Stripe → Payment method domains → add the Vercel domain (Apple Pay).
- [~] **H4 (12:30)** G1 passed; flip `USE_MOCK_SETTLEMENT=0` when the worker deploys. · Gate **G1**, then `USE_MOCK_SETTLEMENT=0`.
- [x] **H5 (14:00)** Sahith deployed it: `https://worker-production-b037.up.railway.app`, /healthz ok (real XRPL + DB), reconciler ok · Deploy worker to Railway; share `WORKER_URL`.

## Lane A: XRPL engine (`packages/xrpl`)

### NI-A1 · Client, currency, crypto, submit queue · 30 min
- [x] 186d20c (client + reconnect, currencyHex, AES-256-GCM seed crypto, per-account submit queue; unit tests)
- **Depends:** G0
- **Paths:** `packages/xrpl/src/{client,currency,crypto,queue}.ts`, tests
- **Do:** Shared `Client` with reconnect; `currencyHex`; AES-256-GCM seed encrypt/decrypt; one-in-flight submit queue per signing account.
- **Done when:** Unit tests pass.

### NI-A2 · Seed · 60 min
- [x] 44d16f5 (idempotent testnet seed: 18 txs, rerun = none; AMM [71590ED7…](https://testnet.xrpl.org/transactions/71590ED706055CD8207B7979EC93B0C828E0D0BBA3B27D506DA9BDF3E89BEC61); ahseng r4JUXhYe…)
- **Depends:** NI-A1
- **Paths:** `packages/xrpl/scripts/seed.ts`, `packages/xrpl/src/setup.ts`
- **Do:** settlement-xrpl.md §2 (DefaultRipple first, trust lines, mint, AMMCreate 10,000/12,900, demo merchant `ahseng`, `.env.seed`). Idempotent.
- **Done when:** Second run changes nothing; AMM visible on testnet.xrpl.org.

### NI-A3 · quote() + settle(): GATE G1 · 60 min
- [x] 7d59015 · **G1 passed**: exactly 12.50 XSGD, [tx BEBA82CD…](https://testnet.xrpl.org/transactions/BEBA82CDEBA86490C3FFC2A92F28A4D33F9494D9D85233460D314B99962EF977)
- **Depends:** NI-A2
- **Paths:** `packages/xrpl/src/{quote,settle,engine}.ts`, `packages/xrpl/scripts/settle-demo.ts`
- **Do:** §3–4; export `createXrplSettlement()` (other methods may throw until A4/A5).
- **Done when:** `settle:demo` delivers exactly 12.50 XSGD. **Gate G1.**

### NI-A4 · createMerchantAccount() + isVerifiedMerchant() · 45 min
- [x] 9a13f22 (Credentials enabled on testnet: create + accept tesSUCCESS; read-only isVerifiedMerchant)
- **Depends:** NI-A3
- **Paths:** `packages/xrpl/src/merchant.ts`
- **Do:** §5: generate, fund, trust lines, Credential create + accept (DB flag fallback), verification via `ledger_entry`.
- **Done when:** A new merchant shows trust lines + accepted Credential; `isVerifiedMerchant` = true.

### NI-A5 · refund(), sweepToRedemption(), sendToWallet(), balance() · 45 min
- [x] 2459b4a (engine:demo PASS: settle, refund, sweep, SGD-float settle, sendToWallet; balances add up)
- **Depends:** NI-A4
- **Paths:** `packages/xrpl/src/{refund,withdraw,balance}.ts`
- **Do:** §6–7, including the destination trust-line check for wallet withdrawals.
- **Done when:** A script refunds, sweeps and sends to a test wallet on testnet; balances add up.

## Lane B: Database + web API (`packages/db`, `apps/web/app/api/*`)

### NI-B1 · DB helpers · 60 min
- [x] every Db method, createDb (postgres.js) + createTestDb (PGlite), migrate + seed:demo; 50 tests incl. the payment + withdrawal balance walk
- **Depends:** G0 (schema applied)
- **Paths:** `packages/db/src/**`
- **Do:** Everything listed in `packages/db/src/index.ts`: row ↔ domain mapping, CAS transitions, `claim`, ledger append (unique kind+ref) + `getBalance` (view), menu/contact name matching (`findMenuItems`, `getContactByName`), `findShop` (shop code → phone → fuzzy name), invoices (all three kinds incl. `pay_request`, 1-hour expiry), onboarding state.
- **Done when:** A script walks a payment and a withdrawal through every status and the balance view is right at each step.

### NI-B2 · `POST /api/checkout` · 60 min
- [x] 6c48f09, 4e6e802, 1cc1678 (payer-currency charge, toggle reuse; live sandbox smoke: real USD PI created, reused, confirmed)
- **Depends:** NI-B1 (mock settlement until G1)
- **Paths:** `apps/web/app/api/checkout/**`, `apps/web/app/api/_lib/**`
- **Do:** payments-stripe.md §1: invoice or fixed-QR target, quote, payment row, Stripe PI in the **payer's currency** (§1a: USD = `quote.usd`, SGD = total; idempotencyKey = paymentId); `bnb` branch stubbed until NI-C6.
- **Done when:** `curl` returns a valid `CheckoutRes` for an invoice code and a fixed-QR basket; Sahith unblocked for SH-A3.

### NI-B3 · Stripe webhook · 40 min
- [x] 7c1c7fe, 61f276a (signature, claim, Apple Pay detection, duplicate-invoice refund; authorizes once)
- **Depends:** NI-B2
- **Paths:** `apps/web/app/api/stripe/**`
- **Do:** §2: raw body + `constructEvent`, `claim`, Apple Pay detection, CAS → authorized, nudge `/internal/settle`.
- **Done when:** A test payment authorizes once even if the event repeats.

### NI-B4 · Public read routes · 30 min
- [x] d63a734, 590696f
- **Depends:** NI-B1
- **Paths:** `apps/web/app/api/{invoices,shops,payments}/**`
- **Do:** `InvoicePublicRes`, `ShopPublicRes` (verified cached 60s), `PaymentStatusRes`; no-store.
- **Done when:** Responses parse with the zod schemas.

### NI-B5 · Merchant routes: me, shop, menu · 40 min
- [x] 65ed6f9, 1d51d46 (MeRes.reconciled; shop.updated only for changed fields)
- **Depends:** NI-B1
- **Paths:** `apps/web/app/api/me/{route.ts,shop,menu}/**`
- **Do:** Session verification with scope checks; `GET /api/me` (`MeRes`, incl. "ledger matches XRPL" flag); `PUT /api/me/shop`, `PUT /api/me/menu` → emit `shop.updated` to the agent.
- **Done when:** The setup page can save and the agent receives `shop.updated`.

### NI-B6 · Bank accounts + withdrawal read API · 45 min
- [x] 420eaff, 6433918 (bank form stores beneficiary id + last4 only, tested for leaks; withdrawal read by ref or owning shop)
- **Depends:** NI-B1, NI-C1 (partner selection)
- **Paths:** `apps/web/app/api/me/bank-accounts/**`, `apps/web/app/api/withdrawals/**`
- **Do:** withdrawals.md §2: `AddBankAccountReq` → `createBeneficiary` → store id + last4 + resolved name only → emit `bank_account.added`. `GET /api/withdrawals/:id` → `WithdrawalRes` with explorer URL.
- **Done when:** The bank form saves without the full number appearing in the DB or logs.

## Lane C: Worker (`apps/worker`)

### NI-C1 · Worker server, emit, merchants route · 45 min
- [x] 5a6def9 (worker :4001 + all route stubs, emitter with replay, merchants route; web API _lib)
- **Depends:** G0
- **Paths:** `apps/worker/src/{index,server,auth,emit,deps,merchants}.ts`
- **Do:** Hono :4001, internal auth, zod stubs for all routes, `emit()` → `events` table + agent POST with retries; mock vs real deps from env; `POST /internal/merchants` → `createMerchantAccount` → status live → `merchant.live`.
- **Done when:** Onboarding (mock engine) gets a live merchant and the event reaches the agent.

### NI-C2 · Settle job + invoice expiry · 60 min
- [x] 893ef3c (settle poller, re-quote on path errors, final failure → Stripe refund + payment.failed; stuck `settling` logged, never re-sent)
- **Depends:** NI-C1, NI-B1
- **Paths:** `apps/worker/src/{settle,expiry}.ts`
- **Do:** `/internal/settle` + 3s poller: CAS authorized → settling → settled, ledger `payment_credit`, invoice paid, contact auto-add, `payment.settled` (with `firstSale`); retries + auto-refund on final failure; expire invoices/QRs.
- **Done when:** Gate **G3** money path with the real engine; duplicates don't double-settle.

### NI-C3 · Create withdrawal (limits, fee, step-up) · 40 min
- [x] 1974c49, cab4666 (limits, fee, step-up rules, wallet trust-line pre-check)
- **Depends:** NI-C1, NI-B1
- **Paths:** `apps/worker/src/withdrawals/create.ts`
- **Do:** withdrawals.md §3a: validate amount vs available + `WITHDRAWAL_LIMITS`, destination (default bank / wallet trust line), fee, `needs_step_up` → `requested` → `InternalCreateWithdrawalRes`.
- **Done when:** Over-limit, no-bank and wallet-without-trust-line cases return clear errors the agent can say.

### NI-C4 · Withdrawal pipeline: GATE G4 · 90 min
- [x] 352e89c … 69ab808 (every docs/06 §3 path tested; `withdraw-smoke ahseng 10` walks to completed FAST-487107 with ledger = chain; MOCK_PAYOUT_FAIL → returned + re-credited). Full G4 still needs the phone + agent
- **Depends:** NI-C3, NI-A5 (mock until then)
- **Paths:** `apps/worker/src/withdrawals/{execute,partner,auto}.ts`, `apps/worker/scripts/withdraw-smoke.ts`
- **Do:** §3c state machine with CAS per step: hold → sweep / sendToWallet → debit → partner payout → callback → completed / returned (`withdrawal_return`) / failed (`withdrawal_release`); resume on boot; `withdrawal.updated` per step; nightly auto-withdraw; `PATCH …/auto-withdraw`.
- **Done when:** `withdraw-smoke` walks to `completed` and the ledger + XRPL balance agree; failure flags behave (docs/06 §3).

### NI-C5 · Refunds · 45 min
- [x] b4120c1 (XRPL exact XSGD → ledger → Stripe in the charge currency; idempotent on actionId; the XRPL refund can't repeat)
- **Depends:** NI-C2, NI-A5
- **Paths:** `apps/worker/src/refunds.ts`
- **Do:** `/internal/refunds` (idempotent on actionId): available check, XRPL merchant → treasury, Stripe refund, ledger `refund_debit`, `refund.completed/failed` (with payer for the customer message).
- **Done when:** One confirmed refund = one Stripe refund + one XRPL tx + one ledger entry.

### NI-C6 · BNB pay-in · 90 min
- [x] 28cf2c2 … aca2e76 (xpub deposit addresses, watcher with 3 confirmations, own tUSDT + `bsc-setup.ts`; replayed a real BSC testnet transfer through the real watcher → authorized → settled). Live run waits on ~0.05 tBNB for the deployer
- **Depends:** NI-C2, NI-B2
- **Paths:** `apps/worker/src/bnb/**`, `apps/worker/scripts/bsc-setup.ts`, `apps/web/app/api/checkout/**` (bnb branch)
- **Do:** bnb-lane.md: test USDT (faucet or Remix ERC-20), fund the Privy demo wallet, HD deposit addresses, viem watcher, 3 confirmations, `claim("bsc:…")`, authorize → settle.
- **Done when:** Gate **G3b**.

### NI-C7 · Reconciler + hardening · 40 min (after G4)
- [x] 814908b … 160c2ce (reconciler every 60s + `GET /internal/reconcile`, /healthz, boot replay, stale-request cancel, money log, Railway docs). **Real e2e smoke passed**: S$12.50 card sale settled on XRPL + S$5.00 withdrawal completed; ledger S$7.50 = XRPL S$7.50 ✓
- **Paths:** `apps/worker/src/{reconcile,boot}.ts`
- **Do:** Every 60s compare ledger (available + held) to XSGD balance per merchant, log drift; boot-time resume + replay of un-acked events; readable logs for the demo laptop.
- **Done when:** `/shop` shows "Ledger ✓ matches XRPL" after the full demo run.

## Extra: AUSD lane (Agora track)

### NI-X1 · AUSD gasless pay-in (ERC-3009) + x402 agent payments
- [x] code done (checkout, `/api/ausd/authorize`, worker relayer, x402 v2); **live x402 run passed**: an agent wallet with no gas paid invoice TVXDDR (S$3.00) with 2.33 AUSD, Rove relayed it on Base Sepolia ([tx](https://sepolia.basescan.org/tx/0xbeca45b34b410d3454e4e36838a7f5c3fc85960462919a721e357bcf3448b229)) and settled it to ahseng on XRPL ([tx](https://testnet.xrpl.org/transactions/19678B95D688E9683135C01B22842A7D8A6A3F91D6C59DD926350B413F0B2CDB))
- **Do:** pay with Agora AUSD on Base Sepolia without gas (payer signs, the worker relays), settle on XRPL like BNB; stretch: an AI agent pays a Rove invoice through x402. Spec: docs/specs/ausd-lane.md

### NI-X2 · Multi-currency corridors (any currency with a stablecoin)
- [x] Phase A: currency registry (USD, SGD, EUR live; INR/AUD/BRL planned), any-to-any XRPL engine through the RLUSD hub, EUR seed + `cafe-berlin`. Testnet: [EUR→SGD](https://testnet.xrpl.org/transactions/F9A8BF3F40D1B309EE53D0F89C2B40A555EF84C443B7133EA6E21500E98D7B66), [USD→EUR](https://testnet.xrpl.org/transactions/2474B08F9BBA69DC0F7A0BA4CF4E58A40C19094BA2DC7E5C5EA221C931044B5C), [SGD→EUR](https://testnet.xrpl.org/transactions/1B272AC58B1074CAF953876DDBECAC5E21F966268A6880FE0F786229D158E435), EUR→EUR
- [ ] Phase B: wire checkout/worker/onboarding/withdrawals to the registry (checklist in docs/specs/corridors.md)
