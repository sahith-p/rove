# Saran: the agent (Photon runtime on iMessage + WhatsApp, Claude, onboarding, actions, voice)

Specs: [agent](../docs/specs/agent.md) · [onboarding](../docs/specs/onboarding.md) · [channels](../docs/specs/channels.md) · [invoicing-and-qr](../docs/specs/invoicing-and-qr.md) (tools) · [voice](../docs/specs/voice.md) · consumer of [imessage-apps](../docs/specs/imessage-apps.md)

## Human (you)

- [ ] **H1 (pre-G0)** Photon project · Meta WhatsApp app + test number · Anthropic key · ElevenLabs key + voice (event coupon) · ffmpeg · [docs/09](../docs/09-services-and-keys.md)
- [ ] **H2 (11:30)** **Submit the `rove_invoice` WhatsApp template** (docs/specs/channels.md). Confirm "hello" from the Photon line reaches phones M and C. Share `SPECTRUM_*` with Sahith.
- [ ] **H3 (12:45–13:00)** Gate **G2** with Sahith; test polls + tapback target.
- [ ] **H4 (14:00)** Deploy agent to Railway; share `AGENT_URL`. **No redeploys during the demo.**
- [ ] **H5 (15:30)** Gate **G4** on phone M.

## Lane A: Runtime, events, actions, onboarding

### SA-A1 · Spectrum runtime + persona routing · 60 min
- [ ] status
- **Depends:** G0
- **Paths:** `apps/agent/src/{index,runtime,personas}.ts`
- **Do:** agent.md §1: iMessage + WhatsApp + terminal providers, `claim("spectrum:"+id)`, sender → `Recipient`, persona (merchant / onboarding / customer; merchants also get customer tools), content switch (text, voice, reaction, poll_option, contact), **payment-code fast path** (`PAYMENT_CODE_RE` → `pay_code`, no Claude), `space.responding`. Presenter: console mock or Sahith's.
- **Done when:** Terminal and phone messages route to the right persona stub; duplicates ignored.

### SA-A2 · Internal HTTP + events → messages · 60 min
- [ ] status
- **Depends:** SA-A1
- **Paths:** `apps/agent/src/{server,events}.ts`
- **Do:** Hono :4002 with internal auth; `POST /internal/events` (dedupe) → handlers per docs/02 "Events" table: sale card + customer invoice-card edit + receipt, refund messages, withdrawal card edits, merchant.live celebration (`effect` confetti), setup-card edit on `shop.updated`, bank saved message.
- **Done when:** The fixture `curl` produces the merchant sale card and the customer receipt; resending does nothing.

### SA-A3 · Pending actions + confirm paths · 60 min
- [ ] status
- **Depends:** SA-A2, NI-B1, NI-C1 (worker stubs OK)
- **Paths:** `apps/agent/src/actions.ts`, `apps/web/app/api/actions/**`
- **Do:** agent.md §5: create (5-min TTL, card + "👍 to…" / "Reply YES to…"), confirm by tapback / YES / card / web → `claimAction` → worker execute → status updates; expiry sweep. Web route verifies `ConfirmTokenPayload` and proxies.
- **Done when:** 👍 triggers exactly one worker call; late 👍 says "expired".

### SA-A4 · Onboarding flow · 75 min
- [ ] status
- **Depends:** SA-A1, NI-C1, SH-B1 (setup/bank builders; console mock until then)
- **Paths:** `apps/agent/src/onboarding.ts`
- **Do:** onboarding.md: contact card share, name, **poll** for category, **setup card**, wait for `shop.updated` or menu text, `/internal/merchants`, confetti + sticker (`qrPng`/`stickerPng` from SH-B6), **bank card**. WhatsApp variant with numbered replies. State in the `onboarding` table.
- **Done when:** Gate **G2b**.

## Lane B: Claude agent + tools

### SA-B1 · Claude loop + prompts · 45 min
- [ ] status
- **Depends:** G0
- **Paths:** `apps/agent/src/agent/{run,prompts,history}.ts`
- **Do:** agent.md §3: toolRunner (`claude-opus-5-5`, effort low, server-side fallbacks), merchant + customer prompts, plain-text append-only history (20), refusal check.
- **Done when:** In the terminal, both personas answer "what can you do?" briefly in < 4 s.

### SA-B2 · Merchant tools · 90 min
- [ ] status
- **Depends:** SA-B1, NI-B1 (fixtures until merged)
- **Paths:** `apps/agent/src/tools/merchant/**`, `apps/agent/src/contacts.ts`
- **Do:** Every `MerchantToolInputs` tool (agent.md §4, invoicing-and-qr.md §2–6): menu, contacts (incl. contact-card intake), `create_invoice` (resolve + send invoice card to the customer), `create_one_time_qr` (PNG), `get_fixed_qr`, invoice ops, reporting, `open_bank_setup`, `propose_withdrawal` (→ `/internal/withdrawals` → action), `propose_refund`, `set_auto_withdraw`.
- **Done when:** Each tool works from the terminal against fixtures; prices always come from the DB.

### SA-B3 · Customer tools + safety pass · 45 min
- [ ] status
- **Depends:** SA-B2
- **Paths:** `apps/agent/src/tools/customer/**`, `apps/agent/src/agent/prompts.ts`
- **Do:** `my_open_invoices`, `pay_invoice`, `pay_code`, `pay_shop` (shop code → phone → fuzzy name; menu pricing; creates `pay_request`; no amount → menu card), `my_receipts`, `start_shop` (invoicing-and-qr.md §7); merchants get these tools too; scoping by phone; bank-number-in-chat handling; untrusted text; out-of-scope refusals.
- **Done when:** Adversarial evals pass.

### SA-B4 · Evals · 45 min
- [ ] status
- **Depends:** SA-B2
- **Paths:** `apps/agent/evals/**`
- **Do:** ≥ 22 JSON cases from agent.md §7 (incl. codes, pay-by-text, merchant-as-customer) + runner (`pnpm --filter agent evals`) on the terminal provider + mocks.
- **Done when:** 100% pass; re-run after prompt changes.

## Lane C: Voice, proactive, WhatsApp

### SA-C1 · Voice in · 30 min
- [ ] status
- **Depends:** SA-A1
- **Paths:** `apps/agent/src/voice.ts`
- **Do:** voice.md §1: `read()` → ElevenLabs STT (ffmpeg if needed) → `turn()`.
- **Done when:** A voice note "how much today?" is answered correctly.

### SA-C2 · Voice out · 40 min
- [ ] status
- **Depends:** SA-C1
- **Paths:** `apps/agent/src/voice.ts`
- **Do:** voice.md §2: TTS → m4a → `voice()` + text; log the bubble-format experiment.
- **Done when:** The reply plays as a voice bubble on phone M.

### SA-C3 · Reminders + recap · 30 min
- [ ] status
- **Depends:** SA-A2
- **Paths:** `apps/agent/src/reminders.ts`
- **Do:** Unpaid invoice nudge after 24h (once), `remind_invoice` backend, 21:00 voice recap (cut first if behind).
- **Done when:** A backdated invoice gets exactly one reminder.

### SA-C4 · WhatsApp polish · 45 min
- [ ] status
- **Depends:** SA-A1, SH-B4 (template send)
- **Paths:** `apps/agent/src/runtime.ts` (WhatsApp branches), `apps/agent/src/onboarding.ts` (numbered replies)
- **Do:** channels.md matrix: YES confirmations, numbered choices instead of polls, links instead of cards, template invoices once approved; phone normalization (digits ↔ E.164).
- **Done when:** A merchant on WhatsApp can onboard, invoice an iMessage customer, and withdraw.
