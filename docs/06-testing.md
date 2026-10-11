# 06 · Testing

Every piece is testable alone with mocks, every seam has one command, and the demo path is rehearsed end to end. Judges check for hard-coded behavior, so these double as proof.

## 1. Unit tests (`pnpm check`)

| Package | Must cover |
|---|---|
| `@rove/shared` | money math (done), tokens (scope + expiry), zod schemas accept fixtures, `links()` |
| `@rove/xrpl` | currency hex, quote math, tx builders (Payment w/ SendMax, AMMCreate, Credential txs, sweep) as pure functions |
| `@rove/imessage-apps` | builders for all 9 kinds (deterministic URL, `v` per state, updateText rules); QR PNG decodes back to the URL |
| `@rove/db` | ledger math: available/held after every withdrawal path (completed, failed before chain, returned) |
| `worker` | payment + withdrawal state machines (CAS), limits + step-up rules, idempotency on actionId / withdrawalId |
| `agent` | persona routing, pending-action lifecycle, YES/👍 matching, menu/contact name resolution |

## 2. Seam tests (one command each, run at the gate)

| Seam | Command | Pass |
|---|---|---|
| XRPL settle (G1) | `pnpm --filter @rove/xrpl settle:demo` | exactly 12.50 XSGD delivered, explorer link |
| Cards (G2) | `pnpm --filter @rove/imessage-apps card-smoke` | setup card on phone M, edited in place |
| Worker → agent | `curl -X POST $AGENT_URL/internal/events -H "authorization: Bearer $INTERNAL_SECRET" -H 'content-type: application/json' -d @apps/agent/evals/fixtures/payment.settled.json` | sale card + receipt card; resending does nothing |
| Webhook → worker | a real test payment or `stripe trigger payment_intent.succeeded` (with metadata) | payment `settled`, ledger `payment_credit`, invoice `paid` |
| Withdrawal (G4) | `pnpm --filter worker withdraw-smoke ahseng 10` (mock or real) | statuses walk to `completed`; ledger available −10, held 0; reconciler OK |
| BNB (G3b) | pay a one-time QR from the Privy demo wallet | `authorized` after 3 confirmations → settled |
| Confirm | 👍 on a confirm text / YES on WhatsApp | exactly one worker execute call |

## 3. Failure injection

| Flag / action | Simulates | Expected |
|---|---|---|
| `MOCK_SETTLE_FAIL=1` | XRPL path dry | 2 retries → `failed` → Stripe auto-refund → customer "you weren't charged", merchant one-liner |
| `MOCK_PAYOUT_FAIL=1` | bank bounces | withdrawal `returned`, `withdrawal_return` re-credits, card "Bank rejected it; money is back in your balance" |
| Pay the same invoice twice (two tabs) | race | second authorization rejected by the unique index → auto-refund |
| 👍 twice / after 5 min | double / late confirm | one execution / "This expired. Ask me again." |
| Withdraw > available | overdraw | `propose_withdrawal` refuses with the available amount |
| Merchant pastes an account number | secret in chat | not stored, not echoed; bank card sent |
| Kill the agent mid-flow | lost card handles | next update sends a new card; no crash |

## 4. Agent evals (Saran, `pnpm --filter agent evals`)

≥ 18 JSON cases (docs/specs/agent.md §7) run against the terminal provider + mocks, asserting tool calls and reply text. Adversarial cases are mandatory. 100% before G4; re-run after every prompt change.

## 5. End-to-end checklist (G3, G4, and 3× in rehearsal)

- [ ] Fresh phone: "hi" → onboarding → setup card → confetti + sticker (G2b)
- [ ] "add chicken rice 5.50, barley 1.50" → menu updated (setup card edits in place)
- [ ] "invoice Maya 2 chicken rice and a barley" → Maya's phone gets the pay card → Apple Pay → "Paid ✓" + receipt; merchant sale card
- [ ] "QR for 6.50" → QR image → phone C scans → pays with the Privy BNB wallet → settled
- [ ] Phone C scans the fixed sticker → picks items → pays
- [ ] "add my bank" → bank card → saved with resolved name
- [ ] "withdraw everything" → step-up on `/w` → *On XRPL → Sent to bank → In your bank* (FAST ref, "simulated")
- [ ] "refund Maya" → 👍 → refunded; Stripe test dashboard shows it
- [ ] Voice note "how much did I make today?" → voice reply with the right number
- [ ] WhatsApp beat: "balance?" from phone W
- [ ] `/shop`: "Ledger ✓ matches XRPL"
