# 05 · Dev setup

## Accounts and keys

Every service, owner, sign-up step and env var: **[`docs/09-services-and-keys.md`](09-services-and-keys.md)**. Finish every "before G0" row first.

## Devices

- **Phone M (merchant):** iPhone; its iMessage number = `DEMO_MERCHANT.phone`. Install **Spectrum by Photon** from inside Messages when the first card arrives.
- **Phone C (customer):** iPhone with a real card in Apple Wallet (Stripe test mode won't charge it); its number = `DEMO_CUSTOMER.phone`; Privy demo login for the BNB button.
- **Phone W (optional):** an Android or second phone on WhatsApp for the WhatsApp beat.
- **Laptop:** XRPL + BscScan testnet explorer tabs, `/shop` page, worker/agent logs.

## Local run

```bash
pnpm i
cp .env.example .env            # fill your section; get the rest from teammates via the shared vault, never git
pnpm seed                       # Nithya, once: writes .env.seed → copy into .env
pnpm dev                        # web :3000 · worker :4001 · agent :4002
stripe listen --forward-to localhost:3000/api/stripe/webhook   # Nithya
```
- Agent without phones: `USE_TERMINAL_PROVIDER=1`; set `TERMINAL_AS=merchant|customer` to choose who you are.
- Cards without Photon: `USE_MOCK_CARDS=1` (printed to the agent log).
- XRPL without the ledger: `USE_MOCK_SETTLEMENT=1`.
- Pages opened from cards need a public URL: test on the Vercel preview, or `cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_BASE_URL`.

## Deploy (from G3)

- `main` auto-deploys web to Vercel; worker + agent redeploy on Railway.
- **Don't redeploy the agent during the demo** (card handles are in memory).
- After env changes on Railway, restart the service and re-run the G3 smoke test.

## Deploy the worker on Railway

One service from this repo; it runs the TypeScript directly with `tsx` (no build output).

| Setting | Value |
|---|---|
| Root directory | the repo root (leave empty): the worker needs the pnpm workspace (`packages/*`) |
| Build command | `pnpm install --frozen-lockfile --prod=false` (`--prod=false` keeps `tsx`, a devDependency, even when `NODE_ENV=production`) |
| Start command | `pnpm --filter worker start` |
| Healthcheck path | `/healthz` → `{"ok":true,"engine":"real","db":"ok",…}`; 503 while the database is unreachable |
| Replicas | **1** (per-merchant and per-withdrawal ordering is in-process; the DB's compare-and-set keeps money safe either way) |
| Node | 20 or newer (Railway's default is fine); pnpm comes from `packageManager` in the root `package.json` |

The worker reads its config from the environment; a repo-root `.env` is loaded only if one exists (local dev), and real env vars always win. After the first deploy, point `WORKER_URL` on Vercel (web) and on the agent service at the Railway URL, then check `curl $WORKER_URL/healthz` and `curl -H "authorization: Bearer $INTERNAL_SECRET" $WORKER_URL/internal/reconcile` (the last ledger-vs-XRPL result per merchant).

Env vars (names only; values in the team vault, never in git):

- **Always:** `INTERNAL_SECRET`, `DATABASE_URL` (Supabase transaction pooler, port 6543), `AGENT_URL`, `PUBLIC_BASE_URL`, `USE_MOCK_SETTLEMENT` (`0` = real XRPL), `USE_MOCK_PAYOUTS` (`1`: simulated StraitsX, the only payout partner wired up). `PORT` is set by Railway.
- **Real XRPL** (`USE_MOCK_SETTLEMENT=0`): `XRPL_WSS`, `XRPL_USD_ISSUER`, `XRPL_SGD_ISSUER`, `XRPL_TREASURY_ADDRESS`, `XRPL_TREASURY_SEED`, `XRPL_REDEMPTION_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_ADDRESS`, `XRPL_CREDENTIAL_ISSUER_SEED`, `WALLET_ENCRYPTION_KEY`; plus `XRPL_ISSUER_<CODE>` for each extra enabled currency (e.g. `XRPL_ISSUER_EUR`).
- **Stripe** (refunds, auto-refund when a settlement fails): `STRIPE_SECRET_KEY`.
- **AUSD lane** (optional; the relayer stays off without the key): `AUSD_RELAYER_PRIVATE_KEY`, `AUSD_PAY_TO`, `AUSD_TOKEN_ADDRESS`, `BASE_SEPOLIA_RPC_URL`, `AUSD_RELAY_POLL_MS`.
- **BNB watcher** (once NI-C6's watcher lands): `BSC_RPC_URL`, `BSC_TOKEN_ADDRESS`, `BSC_TOKEN_DECIMALS`, `BSC_DEPOSIT_MNEMONIC`.
- **Optional tuning:** `LOG_LEVEL`, `SETTLE_POLL_MS`, `EXPIRY_INTERVAL_MS`, `RECONCILE_INTERVAL_MS`, `AUTO_WITHDRAW_CHECK_MS`.
- **Never in a deploy:** `MOCK_SETTLE_FAIL`, `MOCK_PAYOUT_FAIL` (failure injection). The worker doesn't use `TOKEN_SECRET`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_*`, `SPECTRUM_*`, `ANTHROPIC_*`, `ELEVENLABS_*`, the issuer/LP seeds or `DEMO_MERCHANT_*` (seed scripts only).

Live checks from a laptop (real DB, Stripe sandbox, XRPL testnet; from a git worktree add `ROVE_DOTENV=/path/to/rove/.env`):

- `pnpm --filter worker exec tsx scripts/e2e-smoke.ts ahseng`: the G3 money path (invoice → checkout → Stripe → webhook → XRPL settle) plus a S$5.00 withdrawal; prints gate evidence.
- `pnpm --filter worker exec tsx scripts/demo-reset.ts ahseng [--dry-run]`: for a fresh demo merchant whose ledger is empty, sends its stray testnet XSGD back to the treasury so XRPL = ledger.
