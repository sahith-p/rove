# Nithya: money movement (DB, Stripe, XRPL, ledger, withdrawals, BNB, worker)

Specs: [withdrawals](../docs/specs/withdrawals.md) · [settlement-xrpl](../docs/specs/settlement-xrpl.md) · [payments-stripe](../docs/specs/payments-stripe.md) · [invoicing-and-qr](../docs/specs/invoicing-and-qr.md) (DB side) · [bnb-lane](../docs/specs/bnb-lane.md)

## Human (you)

- [ ] **H1 (pre-G0)** Stripe test keys · Supabase + run `packages/db/schema.sql` · Railway (worker + agent services) · BNB testnet faucet · `INTERNAL_SECRET`, `WALLET_ENCRYPTION_KEY`, `BSC_DEPOSIT_MNEMONIC` · [docs/09](../docs/09-services-and-keys.md)
- [ ] **H2 (11:30)** Ripple table: Credentials on testnet? testnet RLUSD issuer? Log answers.
- [ ] **H3 (12:00)** Stripe → Payment method domains → add the Vercel domain (Apple Pay).
- [ ] **H4 (12:30)** Gate **G1**, then `USE_MOCK_SETTLEMENT=0`.
- [ ] **H5 (14:00)** Deploy worker to Railway; share `WORKER_URL`.

## Lane A: XRPL engine (`packages/xrpl`)

### NI-A1 · Client, currency, crypto, submit queue · 30 min
- [ ] status
- **Depends:** G0
- **Paths:** `packages/xrpl/src/{client,currency,crypto,queue}.ts`, tests
- **Do:** Shared `Client` with reconnect; `currencyHex`; AES-256-GCM seed encrypt/decrypt; one-in-flight submit queue per signing account.
- **Done when:** Unit tests pass.

### NI-A2 · Seed · 60 min
- [ ] status
- **Depends:** NI-A1
- **Paths:** `packages/xrpl/scripts/seed.ts`, `packages/xrpl/src/setup.ts`
- **Do:** settlement-xrpl.md §2 (DefaultRipple first, trust lines, mint, AMMCreate 10,000/12,900, demo merchant `ahseng`, `.env.seed`). Idempotent.
- **Done when:** Second run changes nothing; AMM visible on testnet.xrpl.org.

### NI-A3 · quote() + settle(): GATE G1 · 60 min
- [ ] status
- **Depends:** NI-A2
- **Paths:** `packages/xrpl/src/{quote,settle,engine}.ts`, `packages/xrpl/scripts/settle-demo.ts`
- **Do:** §3–4; export `createXrplSettlement()` (other methods may throw until A4/A5).
- **Done when:** `settle:demo` delivers exactly 12.50 XSGD. **Gate G1.**

### NI-A4 · createMerchantAccount() + isVerifiedMerchant() · 45 min
- [ ] status
- **Depends:** NI-A3
- **Paths:** `packages/xrpl/src/merchant.ts`
- **Do:** §5: generate, fund, trust lines, Credential create + accept (DB flag fallback), verification via `ledger_entry`.
- **Done when:** A new merchant shows trust lines + accepted Credential; `isVerifiedMerchant` = true.

### NI-A5 · refund(), sweepToRedemption(), sendToWallet(), balance() · 45 min
- [ ] status
- **Depends:** NI-A4
- **Paths:** `packages/xrpl/src/{refund,withdraw,balance}.ts`
- **Do:** §6–7, including the destination trust-line check for wallet withdrawals.
- **Done when:** A script refunds, sweeps and sends to a test wallet on testnet; balances add up.

## Lane B: Database + web API (`packages/db`, `apps/web/app/api/*`)

### NI-B1 · DB helpers · 60 min
- [ ] status
- **Depends:** G0 (schema applied)
- **Paths:** `packages/db/src/**`
- **Do:** Everything listed in `packages/db/src/index.ts`: row ↔ domain mapping, CAS transitions, `claim`, ledger append (unique kind+ref) + `getBalance` (view), menu/contact name matching (`findMenuItems`, `getContactByName`), invoices, onboarding state.
- **Done when:** A script walks a payment and a withdrawal through every status and the balance view is right at each step.

### NI-B2 · `POST /api/checkout` · 60 min
- [ ] status
- **Depends:** NI-B1 (mock settlement until G1)
- **Paths:** `apps/web/app/api/checkout/**`, `apps/web/app/api/_lib/**`
- **Do:** payments-stripe.md §1: invoice or fixed-QR target, quote, payment row, Stripe PI (SGD, idempotencyKey = paymentId); `bnb` branch stubbed until NI-C6.
- **Done when:** `curl` returns a valid `CheckoutRes` for an invoice code and a fixed-QR basket; Sahith unblocked for SH-A3.

### NI-B3 · Stripe webhook · 40 min
- [ ] status
- **Depends:** NI-B2
- **Paths:** `apps/web/app/api/stripe/**`
- **Do:** §2: raw body + `constructEvent`, `claim`, Apple Pay detection, CAS → authorized, nudge `/internal/settle`.
- **Done when:** A test payment authorizes once even if the event repeats.

### NI-B4 · Public read routes · 30 min
- [ ] status
- **Depends:** NI-B1
- **Paths:** `apps/web/app/api/{invoices,shops,payments}/**`
- **Do:** `InvoicePublicRes`, `ShopPublicRes` (verified cached 60s), `PaymentStatusRes`; no-store.
- **Done when:** Responses parse with the zod schemas.

### NI-B5 · Merchant routes: me, shop, menu · 40 min
- [ ] status
- **Depends:** NI-B1
- **Paths:** `apps/web/app/api/me/{route.ts,shop,menu}/**`
- **Do:** Session verification with scope checks; `GET /api/me` (`MeRes`, incl. "ledger matches XRPL" flag); `PUT /api/me/shop`, `PUT /api/me/menu` → emit `shop.updated` to the agent.
- **Done when:** The setup page can save and the agent receives `shop.updated`.

### NI-B6 · Bank accounts + withdrawal read API · 45 min
- [ ] status
- **Depends:** NI-B1, NI-C1 (partner selection)
- **Paths:** `apps/web/app/api/me/bank-accounts/**`, `apps/web/app/api/withdrawals/**`
- **Do:** withdrawals.md §2: `AddBankAccountReq` → `createBeneficiary` → store id + last4 + resolved name only → emit `bank_account.added`. `GET /api/withdrawals/:id` → `WithdrawalRes` with explorer URL.
- **Done when:** The bank form saves without the full number appearing in the DB or logs.

## Lane C: Worker (`apps/worker`)

### NI-C1 · Worker server, emit, merchants route · 45 min
- [ ] status
- **Depends:** G0
- **Paths:** `apps/worker/src/{index,server,auth,emit,deps,merchants}.ts`
- **Do:** Hono :4001, internal auth, zod stubs for all routes, `emit()` → `events` table + agent POST with retries; mock vs real deps from env; `POST /internal/merchants` → `createMerchantAccount` → status live → `merchant.live`.
- **Done when:** Onboarding (mock engine) gets a live merchant and the event reaches the agent.

### NI-C2 · Settle job + invoice expiry · 60 min
- [ ] status
- **Depends:** NI-C1, NI-B1
- **Paths:** `apps/worker/src/{settle,expiry}.ts`
- **Do:** `/internal/settle` + 3s poller: CAS authorized → settling → settled, ledger `payment_credit`, invoice paid, contact auto-add, `payment.settled` (with `firstSale`); retries + auto-refund on final failure; expire invoices/QRs.
- **Done when:** Gate **G3** money path with the real engine; duplicates don't double-settle.

### NI-C3 · Create withdrawal (limits, fee, step-up) · 40 min
- [ ] status
- **Depends:** NI-C1, NI-B1
- **Paths:** `apps/worker/src/withdrawals/create.ts`
- **Do:** withdrawals.md §3a: validate amount vs available + `WITHDRAWAL_LIMITS`, destination (default bank / wallet trust line), fee, `needs_step_up` → `requested` → `InternalCreateWithdrawalRes`.
- **Done when:** Over-limit, no-bank and wallet-without-trust-line cases return clear errors the agent can say.

### NI-C4 · Withdrawal pipeline: GATE G4 · 90 min
- [ ] status
- **Depends:** NI-C3, NI-A5 (mock until then)
- **Paths:** `apps/worker/src/withdrawals/{execute,partner,auto}.ts`, `apps/worker/scripts/withdraw-smoke.ts`
- **Do:** §3c state machine with CAS per step: hold → sweep / sendToWallet → debit → partner payout → callback → completed / returned (`withdrawal_return`) / failed (`withdrawal_release`); resume on boot; `withdrawal.updated` per step; nightly auto-withdraw; `PATCH …/auto-withdraw`.
- **Done when:** `withdraw-smoke` walks to `completed` and the ledger + XRPL balance agree; failure flags behave (docs/06 §3).

### NI-C5 · Refunds · 45 min
- [ ] status
- **Depends:** NI-C2, NI-A5
- **Paths:** `apps/worker/src/refunds.ts`
- **Do:** `/internal/refunds` (idempotent on actionId): available check, XRPL merchant → treasury, Stripe refund, ledger `refund_debit`, `refund.completed/failed` (with payer for the customer message).
- **Done when:** One confirmed refund = one Stripe refund + one XRPL tx + one ledger entry.

### NI-C6 · BNB pay-in · 90 min
- [ ] status
- **Depends:** NI-C2, NI-B2
- **Paths:** `apps/worker/src/bnb/**`, `apps/worker/scripts/bsc-setup.ts`, `apps/web/app/api/checkout/**` (bnb branch)
- **Do:** bnb-lane.md: test USDT (faucet or Remix ERC-20), fund the Privy demo wallet, HD deposit addresses, viem watcher, 3 confirmations, `claim("bsc:…")`, authorize → settle.
- **Done when:** Gate **G3b**.

### NI-C7 · Reconciler + hardening · 40 min (after G4)
- [ ] status
- **Paths:** `apps/worker/src/{reconcile,boot}.ts`
- **Do:** Every 60s compare ledger (available + held) to XSGD balance per merchant, log drift; boot-time resume + replay of un-acked events; readable logs for the demo laptop.
- **Done when:** `/shop` shows "Ledger ✓ matches XRPL" after the full demo run.
