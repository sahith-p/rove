# 08 · Risks and open questions

## Ask at check-in (log answers in tasks/integration.md)

- [ ] **Organizers:** are pre-written specs/scaffolding OK ("projects must be built during the hackathon")? [Sahith]
- [ ] **YZi:** does BNB Chain pay-in + XRPL settlement qualify? [Sahith]
- [ ] **Ripple:** Credentials enabled on testnet? A testnet RLUSD issuer to use? [Nithya]

## First-hour experiments

- [ ] `app(url, { live: true })` renders our page live in the Spectrum iMessage App? [Sahith]
- [ ] **Apple Pay inside the card's web view**, or only in Safari? [Sahith + Nithya]
- [ ] Tapback on an app card → `reaction` with `target.id` = card id? [Sahith + Saran]
- [ ] Polls (`poll()`) and votes (`poll_option`) work on our Photon plan? [Saran]
- [ ] `.m4a` arrives as a voice bubble? [Saran]
- [ ] WhatsApp template `rove_invoice` approved? (submitted at 11:30) [Saran]

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Photon Free/Pro only messages numbers registered as project Users** (allowlist) | certain | high | add every demo phone as a User in the Photon dashboard before G2; invoicing arbitrary numbers needs the Business plan (say so in the pitch) |
| Apple Pay doesn't run inside the iMessage card | med | med | "Open in Safari to pay" button; card still updates to Paid |
| Photon live rendering differs from docs | med | high | dynamic OG preview images; tap still opens the page |
| WhatsApp template not approved in time | med | low | invoices to iMessage numbers; WhatsApp users pay by QR; show WhatsApp for chat only |
| Agent restart loses card handles | med | med | don't redeploy during the demo; fallback sends new cards |
| XRPL path payment fails (liquidity, DefaultRipple) | med | high | seed sets DefaultRipple first; deep AMM; G1 at 12:30 catches it |
| Ledger ≠ XRPL balance | low | high | every ledger write paired with one tx; reconciler alerts; unique (kind, ref) |
| Credentials not on testnet | low–med | low | DB flag drives the badge |
| BSC testnet RPC slow | med | low | 3 confirmations max; skip the beat |
| Claude latency in chat | low–med | med | effort low, short history, typing indicator |
| Scope creep with many agents | high | high | gates, freeze at 16:00, path ownership, cut list |

## Cut list (in order, if behind at 15:30)

1. Daily voice recap, auto-withdraw scheduler
2. WhatsApp beat (keep it working for chat if cheap)
3. Withdraw-to-own-wallet
4. BNB pay button (keep the slide)
5. Voice replies (keep voice input)
6. `/shop` page (the agent answers everything)

Never cut: onboarding with the setup card → invoice by text → Apple Pay → XRPL settle → withdrawal card to "In your bank".
