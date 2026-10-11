# Rove

A payments agent you text. Merchants set up a shop, send invoices, make QR codes and withdraw to their bank, all by messaging (iMessage + WhatsApp). Customers pay with Apple Pay or card, or with USDT from a BNB Chain wallet. Everything settles on XRPL in the merchant's local stablecoin (XSGD), and cashes out to their bank in SGD.

B@BHacks 2.0 · Target tracks: **Ripple**, **YZi**, **ElevenLabs**, **Most Technically Impressive**.

> **Hackathon rule check.** "Projects must be built during the hackathon." This repo holds planning docs, shared contracts and empty stubs, nothing that works yet. Confirm with the organizers at check-in that pre-written specs and scaffolding are allowed. If they aren't, create a fresh repo at 11:30 and copy only `docs/` and `tasks/`.

## Start here

| You are | Read in this order |
|---|---|
| Anyone (human or agent) | [`CLAUDE.md`](CLAUDE.md) → [`docs/00-overview.md`](docs/00-overview.md) → [`docs/01-architecture.md`](docs/01-architecture.md) → [`docs/02-contracts.md`](docs/02-contracts.md) |
| **Sahith**: minimal web app, iMessage App cards, QR images, Privy, demo | [`tasks/sahith.md`](tasks/sahith.md) · specs: [web-app](docs/specs/web-app.md), [imessage-apps](docs/specs/imessage-apps.md), [invoicing-and-qr](docs/specs/invoicing-and-qr.md), [design](docs/specs/design.md) |
| **Nithya**: money (DB, Stripe, XRPL, ledger, withdrawals, BNB, worker) | [`tasks/nithya.md`](tasks/nithya.md) · specs: [withdrawals](docs/specs/withdrawals.md), [settlement-xrpl](docs/specs/settlement-xrpl.md), [payments-stripe](docs/specs/payments-stripe.md), [bnb-lane](docs/specs/bnb-lane.md) |
| **Saran**: the agent (Photon runtime, iMessage + WhatsApp, Claude, onboarding, voice) | [`tasks/saran.md`](tasks/saran.md) · specs: [agent](docs/specs/agent.md), [onboarding](docs/specs/onboarding.md), [channels](docs/specs/channels.md), [voice](docs/specs/voice.md) |
| Setting up accounts / keys | [`docs/09-services-and-keys.md`](docs/09-services-and-keys.md) |
| Integrating at a gate | [`docs/04-build-order-and-integration.md`](docs/04-build-order-and-integration.md) · [`tasks/integration.md`](tasks/integration.md) |

## Repo map

```
apps/
  web/        Next.js on Vercel: minimal web app (/pay /m /r /setup /bank /w /confirm /shop) (Sahith) + /api (Nithya, Saran)
  worker/     Long-running: settlement, ledger, refunds, withdrawal pipeline, BNB watcher, reconciler (Nithya)
  agent/      Long-running: Photon Spectrum (iMessage + WhatsApp) + Claude agent for merchants and customers (Saran)
packages/
  shared/     FROZEN contracts: domain types, API schemas, events, interfaces, links, tokens, mocks (all three)
  db/         Postgres schema + typed queries (Nithya)
  xrpl/       XRPL settlement engine + seed script (Nithya)
  imessage-apps/  iMessage App card builders + presenter (send / edit in place) + QR images (Sahith)
docs/         00–09 overview → services & keys; specs/ per component
tasks/        Per-person task lists in parallel agent lanes + integration log
```

## Commands

```bash
pnpm i          # install
pnpm dev        # web + worker + agent
pnpm check      # typecheck + tests, run before every PR
pnpm seed       # XRPL testnet issuers, treasury, AMM pool, demo merchant
```

Accounts and keys: [`docs/09-services-and-keys.md`](docs/09-services-and-keys.md). Local setup: [`docs/05-dev-setup.md`](docs/05-dev-setup.md).
