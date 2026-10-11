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
