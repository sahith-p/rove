# 09 · Services, accounts and keys

Every external service Rove touches, who sets it up, and exactly which values go in `.env`. Tick the box when the key is in the shared vault **and** in every place it's needed (local `.env`, Vercel, Railway).

**Sharing secrets:** use one shared password-manager vault (1Password / Bitwarden) or a disappearing-message share. Never paste keys in the repo, a PR, or the team chat history. Everything here is **test mode / testnet**.

## Must have before G0 (11:50)

| ✓ | Service | Owner | Why we need it | Sign up | Env vars it produces | Free / cost |
|---|---|---|---|---|---|---|
| [ ] | **Photon (Spectrum)** | Saran | the agent on iMessage: send/receive, App cards, edits, polls, effects, tapbacks, contact cards, voice notes | app.photon.codes → new project → Settings | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Free/Pro use a shared line pool (fine for DMs); Business = dedicated number |
| [ ] | **Meta WhatsApp Business** (via Photon) | Saran | the agent on WhatsApp; **submit the `rove_invoice` template at 11:30** (docs/specs/channels.md) | developers.facebook.com → app → WhatsApp → API setup (test number OK), or a Photon cloud WhatsApp line if your plan has one | `SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN`, `SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID`, `SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET` | free test number; template approval time varies |
| [ ] | **Anthropic (Claude API)** | Saran | the merchant agent (`claude-opus-5-5`) | Claude Console (console.anthropic.com) → API keys | `ANTHROPIC_API_KEY` | pay-as-you-go; add credit first |
| [ ] | **Stripe** (test mode) | Nithya | Apple Pay / card checkout, refunds | dashboard.stripe.com → toggle **Test mode** → Developers → API keys | `STRIPE_SECRET_KEY` (sk_test_…), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (pk_test_…), `STRIPE_WEBHOOK_SECRET` (whsec_…, from the webhook endpoint or `stripe listen`) | free in test mode |
| [ ] | **Supabase** | Nithya | Postgres for every state machine | supabase.com → new project → Settings → API | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | free tier |
| [ ] | **XRPL testnet** | Nithya | settlement, AMM, Credentials | no account; `pnpm seed` funds wallets from the faucet | `XRPL_WSS`, `XRPL_USD_ISSUER`, `XRPL_SGD_ISSUER`, `XRPL_TREASURY_SEED`, `XRPL_REDEMPTION_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_SEED` (written to `.env.seed`) | free |
| [ ] | **GitHub** | Sahith | repo (must be public at submission), PRs, CODEOWNERS | github.com → new repo → invite Nithya + Saran | — | free |
| [ ] | **Generated secrets** | Nithya (internal), Sahith (tokens) | service-to-service auth, signed links, merchant key encryption | `openssl rand -hex 32` (three times) | `INTERNAL_SECRET`, `TOKEN_SECRET`, `WALLET_ENCRYPTION_KEY` | — |

## Needed by G2–G3 (13:00–14:30)

| ✓ | Service | Owner | Why | Sign up | Env vars | Free / cost |
|---|---|---|---|---|---|---|
| [ ] | **Vercel** | Sahith | hosts `apps/web` on a stable HTTPS domain (Apple Pay + the pages cards open) | vercel.com → import repo → Root Directory `apps/web` | sets `PUBLIC_BASE_URL`; add all web env vars in Project Settings | free (Hobby) |
| [ ] | **Railway** | Nithya | hosts `apps/worker` and `apps/agent` (long-running) | railway.com → new project → 2 services from the repo | `WORKER_URL`, `AGENT_URL` (their public URLs); paste each service's env vars | trial credit |
| [ ] | **Apple Pay domain** (via Stripe) | Nithya | Apple Pay only shows on a registered domain | Stripe → Settings → Payment method domains → add the Vercel domain | — | free; no Apple developer account needed for web Apple Pay through Stripe |
| [ ] | **ElevenLabs** | Saran | speech-to-text for voice notes + voice replies | elevenlabs.io → Profile → API keys; pick a voice id. Claim hackathon credits in the event Discord (#coupon-codes → Start Redemption) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | event coupon |
| [ ] | **Privy** | Sahith | customer embedded EVM wallet for the BNB Chain pay button | dashboard.privy.io → new app → enable embedded wallets + BSC testnet (chainId 97); add the Vercel domain to allowed origins; create **one demo customer login** (Privy test account if available, else a team email) and pre-fund its wallet | `NEXT_PUBLIC_PRIVY_APP_ID` | free tier |
| [ ] | **BNB Chain testnet** | Nithya | pay-in lane: test USDT, deposit addresses | BNB Chain testnet faucet (tBNB); test USDT from the faucet or deploy our ERC-20 in Remix | `BSC_RPC_URL`, `BSC_TOKEN_ADDRESS`, `BSC_TOKEN_DECIMALS`, `BSC_DEPOSIT_MNEMONIC` (generate a fresh testnet-only mnemonic) | free |

## Tools on laptops (no keys)

| Tool | Who | Install |
|---|---|---|
| Node 22 + pnpm 10 | everyone | `corepack enable` |
| Stripe CLI | Nithya | `brew install stripe/stripe-cli/stripe` → `stripe login` |
| ffmpeg | Saran | `brew install ffmpeg` (voice note conversion) |
| cloudflared (optional) | anyone testing card pages locally | `brew install cloudflared` |
| Claude Code | everyone | for the agent lanes |

## Devices and apps

| Item | Who | Notes |
|---|---|---|
| Phone C (customer iPhone) | Sahith | real card in Apple Wallet (test mode won't charge it); Privy demo login; number = `DEMO_CUSTOMER.phone` |
| Phone W (WhatsApp, optional) | anyone | for the WhatsApp beat |
| Phone M (merchant iPhone) | Saran | its iMessage number goes in `DEMO_MERCHANT.phone`; install **Spectrum by Photon** from inside Messages when the first card arrives |
| Printed QR sticker | Sahith | from `/d/qr` after G3 |

## Not needed for the demo (production only, mention on a slide)

| Service | Why we'd need it in production |
|---|---|
| StraitsX business account + API access | real XSGD redemption and SGD payouts over PayNow/FAST (API access via their sales team) |
| Ripple (real RLUSD) | mainnet dollar float |
| A dedicated Photon line (Business plan) | one Rove number for everyone, group chats (e.g. split bills) |
| KYB provider / partner-hosted verification | verify merchants before their first withdrawal |

## Submission accounts

| ✓ | What | Owner |
|---|---|---|
| [ ] | YouTube account for the unlisted 2-minute demo | Sahith |
| [ ] | hackathoncompany.com/platform account for submission | Sahith |

## Where each var lives

| Var | Local `.env` | Vercel (web) | Railway worker | Railway agent |
|---|---|---|---|---|
| `PUBLIC_BASE_URL`, `TOKEN_SECRET` | ✓ | ✓ | ✓ | ✓ |
| `INTERNAL_SECRET`, `WORKER_URL`, `AGENT_URL` | ✓ | ✓ | ✓ | ✓ |
| `SUPABASE_*` | ✓ | ✓ | ✓ | ✓ |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | ✓ | ✓ | ✓ (refunds) | |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PRIVY_APP_ID` | ✓ | ✓ | | |
| `XRPL_*`, `WALLET_ENCRYPTION_KEY` | ✓ | ✓ (quote, verified badge) | ✓ | |
| `BSC_*` | ✓ | ✓ (deposit addresses) | ✓ (watcher) | |
| `SPECTRUM_*` (incl. WhatsApp), `ANTHROPIC_API_KEY`, `ELEVENLABS_*` | ✓ | | | ✓ |
| `USE_MOCK_*`, `USE_TERMINAL_PROVIDER` | ✓ | ✓ | ✓ | ✓ |
