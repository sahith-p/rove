# Spec · Balances and withdrawals (the cash-out pipeline)

Owner: **Nithya** (pipeline, APIs, ledger) · **Sahith** (`/bank`, `/w/[id]` pages, withdrawal card) · **Saran** (agent tools + confirmations) · Tasks: NI-C3, NI-C4, NI-B6, NI-C7, SH-C1, SH-C2, SA-B2, SA-A3

**In one sentence:** the merchant's money sits as XSGD in a custodial XRPL account Rove holds for them. "Withdraw" moves it either to their bank in SGD (XSGD → StraitsX redemption → PayNow/FAST payout) or to their own XRPL wallet. Every step is confirmed by a human, held in a ledger first, and idempotent.

## 1. Where the money is

| Layer | What it holds | Source of truth for |
|---|---|---|
| Merchant's custodial XRPL account | XSGD (trust line to the XSGD issuer) | **funds** |
| `ledger_entries` (Postgres, append-only) | credits, refunds, holds, debits | **availability**: what can be withdrawn right now |
| `withdrawals` | each cash-out and its state | **progress** |

`available = Σ payment_credit + Σ withdrawal_release + Σ withdrawal_return − Σ refund_debit − Σ withdrawal_hold`
`held = Σ withdrawal_hold − Σ withdrawal_release − Σ withdrawal_debit`
**Invariant:** `available + held` == XSGD balance on the merchant's XRPL account. The reconciler (NI-C7) checks every 60s and logs + alerts on drift. The demo shows "Ledger ✓ matches XRPL" on `/shop`.

Custody: demo = platform-held keys (seed AES-256-GCM encrypted with `WALLET_ENCRYPTION_KEY`). Production = MPC/KMS or a regulated custodian; the merchant can always withdraw to self-custody.

## 2. Adding a bank account (once)

1. Merchant: "add my bank" (or onboarding asks). The agent sends the **bank card** → `/bank?t=<session scope=bank, 15 min>`.
2. The form (Sahith) offers three types for SG: **PayNow UEN**, **PayNow mobile**, **bank account** (bank picker + account number). Plus holder name.
3. `POST /api/me/bank-accounts` (Nithya):
   - validate with `AddBankAccountReq`
   - `payoutPartner.createBeneficiary(...)` → `{ beneficiaryId, resolvedName, nameMatches, status, last4 }` (production: StraitsX beneficiary + bank name enquiry; demo: mock)
   - store **only** `beneficiary_id`, `last4`, `holder_name` (resolved), `bank_name`, `type`, `status`; the full number is never written to our DB or logs
   - first account becomes default; emit `bank_account.added` with label `"DBS ••••1234 (AH SENG FOOD PTE LTD)"`
4. Agent replies: "Saved DBS ••••1234 (AH SENG FOOD PTE LTD) ✓. Say 'withdraw' anytime."
5. If the merchant types account numbers in chat anyway, the agent doesn't store or repeat them, and replies with the bank card ("For safety, add it here instead").

## 3. Withdrawing

### 3a. Request (agent, no money moves)
Merchant: "withdraw everything" / "withdraw 50" / "send 20 to my wallet rP4x…".
- Tool `propose_withdrawal` → `POST /internal/withdrawals { merchantId, amount|null, destination|null }`
- Worker validates and creates `status=requested`:
  - amount ≤ available; ≥ S$1.00; daily total ≤ S$2,000 (demo limits in `WITHDRAWAL_LIMITS`)
  - destination: default bank, or `xrpl_wallet` (address must have an XSGD trust line: check `account_lines`, else explain how to add one)
  - fee: S$0.00 (FAST), shown anyway
  - `needs_step_up = true` if it's the first withdrawal, the bank account is < 24h old, or amount > S$200
- Agent creates a pending action (`kind: withdrawal`) and sends the **confirm card** + "👍 to withdraw S$118.40 to DBS ••••1234 (free, ~1 min)". WhatsApp: "Reply YES to withdraw…".

### 3b. Confirm (human)
- 👍 tapback / YES reply / Confirm button → `claimAction` (plain code).
- If `needs_step_up`: the agent instead sends the **withdrawal card** (`/w/<id>?t=`), where the merchant taps **Confirm withdrawal** on the page (the step-up), which posts to `/api/actions/:id/confirm` with `via: "web"`. Production would add a passkey / OTP here.
- Executor → `POST /internal/withdrawals/:id/execute { actionId }`.

### 3c. Execute (worker, NI-C4): state machine
```
requested ──confirm──► approved ──► onchain_pending ──► onchain_settled ──► payout_pending ──► completed
     │                    │                │                                    │
  cancelled/expired     failed          failed                              returned
 (no ledger change)  (hold released)  (hold released)                 (re-credited to balance)
```
| Step | Worker does | Ledger | Event |
|---|---|---|---|
| approve | CAS `requested → approved` | `withdrawal_hold` (ref = wd id) | `withdrawal.updated approved` |
| on-chain | bank: `sweepToRedemption` (merchant → REDEMPTION, `InvoiceID = sha256(wd_id)`) · wallet: `sendToWallet` | — | `onchain_pending` |
| validated | record `sweep_tx_hash`; check `delivered_amount` == amount | `withdrawal_debit` | `onchain_settled` (wallet withdrawals end here: `completed`) |
| payout | `createPayout({ beneficiaryId, amount, idempotencyKey: wd_id })` | — | `payout_pending` |
| partner callback | `completed` + `bank_ref` | — | `completed` |
| partner failure | `returned`: production, StraitsX returns XSGD; demo, the treasury re-sends XSGD to the merchant | `withdrawal_return` (+available; `withdrawal_release` is only for failures before funds leave) | `returned` |
| on-chain failure | `failed`, reason | `withdrawal_release` | `failed` |

- Every step is a compare-and-set on `status`, so a retried `/execute` resumes where it stopped instead of repeating.
- Recovery on boot: resume any withdrawal in `approved`/`onchain_pending`/`payout_pending` (check tx by InvoiceID / poll partner).
- Auto-withdraw (`daily`): at 21:00 SGT the worker creates + approves a withdrawal for the full available balance to the default bank (pre-confirmed by the merchant's earlier "auto-withdraw daily" action). Skips if < S$1.

### 3d. Merchant sees (the withdrawal card, edited in place on iMessage)
`Requested → On XRPL ✓ (tx link) → Sent to bank ✓ → In your bank ✓ FAST-881245`, footer "Bank payout simulated in demo". WhatsApp: one message at `completed` or `failed`.

## 4. Refunds and the ledger

Refund (confirmed action) → worker: merchant XSGD → treasury (`settlement.refund`), Stripe refund to the customer, ledger `refund_debit`. Refunds need available balance ≥ amount; if the money was already withdrawn, the agent says so and offers to refund once new sales arrive (no negative balances in the demo).

## 5. Production path (slide, not build)

- **StraitsX** (MAS-licensed; XSGD live on XRPL since May 2025): beneficiaries, payouts (`POST /payouts`, callbacks `pending | completed | failed`), sandbox at `api-sandbox.straitsx.com`. **API access is not self-serve.** Whether payouts target a PayNow UEN directly is unconfirmed; the mock supports both.
- KYB before first withdrawal (the partner's hosted verification link, sent as a card).
- Other countries: one licensed payout partner per corridor behind the same `PayoutPartner` interface (India: a licensed Indian PSP paying to bank/UPI; no INR stablecoin on XRPL, so the float stays in USD).

## 6. Demo checklist

- [ ] Bank card → form → "DBS ••••1234 (AH SENG FOOD PTE LTD) saved ✓"
- [ ] "withdraw everything" → step-up on `/w` (first withdrawal) → card steps through to FAST ref
- [ ] Explorer shows merchant → REDEMPTION XSGD payment with the InvoiceID
- [ ] `/shop` shows balance S$0.00 and "Ledger ✓ matches XRPL"
- [ ] Bonus: "send 5 to my wallet r…" → real XSGD lands in a teammate's testnet wallet
