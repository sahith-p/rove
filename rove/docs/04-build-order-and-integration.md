# 04 · Build order and integration

Hacking runs **11:30 AM–5:15 PM**. Submission takes ~15 minutes, so **submit by 5:00**. Each person builds against mocks; the risky integrations happen early.

## Gates

| Gate | Time | Pass test (run it, paste evidence in `tasks/integration.md`) | Who |
|---|---|---|---|
| **G0 · Setup** | 11:50 | `pnpm i && pnpm check` green · `.env` complete (docs/09) · schema applied · Photon "hello" on the merchant + customer iPhones · Stripe test keys work · `pnpm seed` prints the AMM link · **WhatsApp invoice template submitted to Meta** | all |
| **G1 · Ledger** | 12:30 | `pnpm --filter @rove/xrpl settle:demo` delivers **exactly 12.50 XSGD** to `ahseng` on testnet + explorer link | Nithya |
| **G2 · Card on phone** | 13:00 | `pnpm --filter @rove/imessage-apps card-smoke`: setup card arrives on the merchant iPhone, opens `/setup` inside Messages, then `update()` changes the **same bubble** | Sahith + Saran |
| **G2b · Onboarding by chat** | 13:45 | Fresh phone texts "hi" → name → category poll → setup card (menu saved) → custodial XRPL account + Credential → confetti + fixed QR sticker | Saran + Sahith + Nithya |
| **G3 · Invoice paid** | 14:30 | Deployed: merchant texts "invoice Maya 2 chicken rice and a barley" → Maya's phone gets the pay card → Apple Pay → card turns "Paid ✓", receipt arrives, merchant gets the sale card; explorer shows the path payment | all |
| **G3b · BNB pay-in** | 15:00 | Pay a one-time QR with the Privy demo wallet (test USDT on BSC testnet) → same settle + cards | Nithya + Sahith |
| **G4 · Withdraw + refund** | 15:30 | Bank card → bank saved · "withdraw everything" → 👍 → withdrawal card: *On XRPL → Sent to bank → In your bank* (simulated FAST ref) · "refund Maya" → 👍 → refunded · voice note answered by voice | Nithya + Saran + Sahith |
| **G5 · Freeze** | 16:00 | Bug fixes only. Rehearse the demo 3× (docs/07) | all |
| Record | 16:30 | 2-minute video uploaded (unlisted) | Sahith |
| Submit | 16:45–17:00 | Public repo, video, live link | Sahith |

## Lanes at a glance

```
11:30 ─G0─ 12:30 ─G1─ 13:00 ─G2─ 13:45 ─G2b─ 14:30 ─G3─ 15:00 ─G3b─ 15:30 ─G4─ 16:00 freeze
Sahith  shell · pay page(mock) │ builders · setup/bank pages │ presenter ★G2 · QR images │ Apple Pay · receipt · confirm │ withdrawal page · Privy · demo
Nithya  db · seed · settle ★G1 │ me/shop/menu APIs · merchants │ checkout · webhook · settle │ ledger · withdrawals ★G4 · BSC │ refunds · reconciler
Saran   spectrum runtime(terminal) │ persona routing · Claude loop │ onboarding ★G2b │ invoices/QR tools · events→cards │ actions 👍 · voice · evals
```
Task-level detail: `tasks/sahith.md`, `tasks/nithya.md`, `tasks/saran.md`.

## Rules for parallel agents

1. **One task ID per agent session**, own worktree + branch:
   ```bash
   git worktree add ../rove-NI-A3 -b nithya/NI-A3-settle
   cd ../rove-NI-A3 && claude "Do task NI-A3 from tasks/nithya.md. Read CLAUDE.md first."
   ```
2. Up to **3 lanes per person** in parallel (A, B, C). Tasks in a lane are sequential; lanes touch disjoint paths.
3. The human reviews + merges PRs, keeps their task file current, runs gate tests.
4. Merge small and often (≥ every 45 min per lane). `pnpm check` green before merging.
5. Blocked on another owner → add a row under **Requests** in `tasks/integration.md`, switch to the mock, keep going.

## Integration instructions per seam

### A · Agent ↔ card presenter (G2)
1. Sahith exports `createCardBuilders({ baseUrl })` and `createSpectrumCardPresenter(spectrum)` from `@rove/imessage-apps`.
2. Saran builds the presenter once at boot with the live Spectrum instance; with `USE_MOCK_CARDS=1` passes `createConsoleCardPresenter()` (same interface).
3. Card handles live in memory: **don't restart the agent during the demo** (later updates would become new bubbles).

### B · Onboarding: agent ↔ setup page ↔ worker (G2b)
1. Nithya ships `PUT /api/me/shop`, `PUT /api/me/menu` (emit `shop.updated`) and `/internal/merchants` on the mock engine first.
2. Sahith's `/setup` page uses them with the `t` token from the card URL.
3. Saran's onboarding sends the setup card, reacts to `shop.updated`, calls `/internal/merchants`, then celebrates on `merchant.live`.

### C · Invoice → checkout → settle → events (G3)
1. Saran's `create_invoice` tool writes through `@rove/db` (`createInvoice`) and sends the invoice card via the presenter.
2. Nithya's `/api/checkout` + webhook + `/internal/settle` run with `USE_MOCK_SETTLEMENT=1` until G1, then real.
3. Sahith's `/pay/[code]` integrates the real checkout by ~13:45. Apple Pay works **only on the deployed HTTPS domain registered in Stripe**; locally use card 4242.
4. Test the event seam alone: `curl -X POST $AGENT_URL/internal/events -H "authorization: Bearer $INTERNAL_SECRET" -H 'content-type: application/json' -d @apps/agent/evals/fixtures/payment.settled.json`.

### D · Withdrawals (G4)
1. Nithya ships `/internal/withdrawals` (create) + `/execute` on the mock engine + mock partner, emitting `withdrawal.updated` per step.
2. Saran's `propose_withdrawal` calls create, then makes the pending action; the executor calls execute after 👍.
3. Sahith's `/w/[id]` page polls `GET /api/withdrawals/:id`; step-up confirm posts to `/api/actions/:id/confirm`.

### E · BNB pay-in (G3b)
Nithya's checkout returns `bnb` deposit details; Sahith's Privy button sends the transfer; the worker's watcher authorizes, and the rest is shared.

## Mock → real switch-over

- [ ] G1 → `USE_MOCK_SETTLEMENT=0` on worker + web (local + deployed)
- [ ] G2 → `USE_MOCK_CARDS=0` on agent
- [ ] Before the demo → `USE_TERMINAL_PROVIDER=0`; payouts stay simulated and labeled
