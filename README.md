# Rove

Rove is a payments agent you text. A small shop sets itself up over iMessage, sends invoices and QR codes, and withdraws to its bank, all in one thread with one phone number. A customer from anywhere pays in their own currency, and the shop receives its own currency as a stablecoin on the XRP Ledger.

Built at B@BHacks 2.0 by Sahith, Nithya and Saran.

- Web app: https://rove-topaz.vercel.app
- Worker health: https://worker-production-b037.up.railway.app/healthz

## The problem

A tourist in Singapore with a US card wants to buy S$12.50 of chicken rice. Hawker stalls mostly take cash or local QR codes (PayNow, SGQR), which need a Singapore bank account. If the stall does take cards, the tourist usually pays a ~3% foreign transaction fee to their bank, or a 3–12% markup if the terminal offers to charge in dollars (dynamic currency conversion).

Rove charges the tourist in dollars, swaps once at the market rate on XRPL, and pays the stall exactly S$12.50 in a Singapore-dollar stablecoin. The stall can withdraw to its bank whenever it wants.

## How it works

**Merchant** (texts the Rove number):
- "hi": onboarding in the chat. Shop name, category, menu editor in an iMessage App card, then a custodial XRPL account with a "verified merchant" Credential and a printable QR sticker.
- "invoice Maya 2 chicken rice": prices come from the menu in the database, and Maya gets a pay card in her own thread.
- "QR for 6.50": a one-time code and QR image. The customer scans it or texts the code.
- "add my bank": a secure web form. Bank numbers never go through the chat or into our database.
- "withdraw everything": the agent proposes it, the merchant confirms (👍 or a web step-up for large and first withdrawals), and a live card steps through *On XRPL → Sent to bank → In your bank*.
- "refund Maya", "balance?", and voice notes, answered by voice through ElevenLabs.

**Customer**: taps a pay card, scans a QR, or texts "pay ahseng 6.50". The pay page offers:

| Rail | What the payer does | Card fees |
|---|---|---|
| Apple Pay / card (Stripe) | Pays in their own currency (USD, SGD or EUR), so the card leg never converts | 2.9% + 30¢ (merchant side) |
| BNB Chain wallet | Sends USDT on BSC testnet (Privy embedded wallet or MetaMask) to a per-payment deposit address | none |
| AUSD, gasless | Signs an ERC-3009 authorization on Base Sepolia. Rove relays it and pays the gas, so the payer needs no ETH | none |

Everything lands the same way: one XRPL Payment from Rove's treasury delivers the exact local amount to the merchant's account.

For developers there's also an x402 endpoint (`/api/x402/invoices/<code>`): software agents can pay an invoice URL with AUSD over HTTP `402 Payment Required`. It isn't part of the customer or merchant UI.

**Who runs the agent.** One number serves everyone. The sender's phone decides the role: a live merchant's number gets merchant tools plus customer tools, and anyone else gets customer tools. The agent (Claude) can't move money. Refunds, withdrawals and setting changes become pending actions, and only a human confirmation lets plain code execute them.

## Money path

```
payer's currency                                                        merchant's currency
──────────────────                                                      ───────────────────
card in USD/SGD/EUR (Stripe) ─┐
USDT on BSC testnet ──────────┼─► Rove treasury float on XRPL ──► one XRPL Payment ──► merchant's custodial
AUSD on Base Sepolia ─────────┘    (RLUSD / XSGD / EUR)             through the AMM      account (XSGD or EUR)
                                                                     (RLUSD hub)                │
                                                                                                │ "withdraw" (human-confirmed)
                                                         ┌──────────────────────────────────────┤
                                                         ▼                                      ▼
                                          bank: XSGD → redemption account          own XRPL wallet
                                          → SGD over FAST (simulated StraitsX)     (real on testnet)
```

- The currency changes exactly once, as a stablecoin-to-stablecoin swap at the AMM's market rate (our testnet pool's fee is 0.03%). Same-currency payments don't swap at all.
- Any enabled pair routes in a single Payment through the RLUSD hub, e.g. EUR → RLUSD → XSGD.
- Postgres keeps an append-only ledger (credits, refunds, holds, debits). The rule `available + held == XSGD balance on XRPL` is checked for every merchant every 60 seconds.

## Verified on testnet

Each of these ran against the real services named, not mocks.

| What | Evidence |
|---|---|
| Settlement: S$12.50 quoted in USD, exactly 12.50 XSGD delivered through the AMM | [XRPL tx BEBA82CD…](https://testnet.xrpl.org/transactions/BEBA82CDEBA86490C3FFC2A92F28A4D33F9494D9D85233460D314B99962EF977) |
| Full card path on Supabase + Stripe sandbox + XRPL: invoice → US$9.77 charge → signed webhook → settle → ledger | [XRPL tx 61D6C6BF…](https://testnet.xrpl.org/transactions/61D6C6BFC13B78D4D367CEC0CC2C3931B510E13B6B6666D45C52D07C6BF39A79) |
| Apple Pay on the deployed site (iPhone): US$14.45 charged, settled as exactly S$18.50 to Ah Seng | [XRPL tx BEA6F8DE…](https://testnet.xrpl.org/transactions/BEA6F8DEA7F3ACA7196378A69B720E07E2C6124727841846F3D3970A723371CA) |
| Withdrawal: S$5.00 walked requested → approved → on XRPL → payout → completed; ledger = XRPL afterwards | [XRPL tx 0CFE1211…](https://testnet.xrpl.org/transactions/0CFE1211073CA8702C972FDA9202537C7461D191E6F2E0C01ABAA5154C17948C) |
| Merchant verification: Credential created and accepted | [create 7D603A6B…](https://testnet.xrpl.org/transactions/7D603A6B95446E0E79C151511511F637E11E93B6844CBE1D4FB5D7B81B6C4E10), [accept FE0FC4EC…](https://testnet.xrpl.org/transactions/FE0FC4ECC38D6FBF26A1D43BCB8C3B10BCD52D0696A3B6B2A95C03AE26833B78) |
| Corridors, one Payment each: EUR → SGD, USD → EUR, SGD → EUR (2 hops), EUR → EUR | [F9A8BF3F…](https://testnet.xrpl.org/transactions/F9A8BF3F40D1B309EE53D0F89C2B40A555EF84C443B7133EA6E21500E98D7B66), [2474B08F…](https://testnet.xrpl.org/transactions/2474B08F9BBA69DC0F7A0BA4CF4E58A40C19094BA2DC7E5C5EA221C931044B5C), [1B272AC5…](https://testnet.xrpl.org/transactions/1B272AC58B1074CAF953876DDBECAC5E21F966268A6880FE0F786229D158E435), [5C78BF0D…](https://testnet.xrpl.org/transactions/5C78BF0D7BCA2B7A7ED276CD88FE12F41A0A2B33FEE232FBEF55393CAD05F5B8) |
| AUSD, gasless (via the x402 developer endpoint): a wallet with no gas paid a S$3.00 invoice with 2.33 AUSD. Rove relayed it, then settled S$3.00 on XRPL | [Base Sepolia 0xbeca45b3…](https://sepolia.basescan.org/tx/0xbeca45b34b410d3454e4e36838a7f5c3fc85960462919a721e357bcf3448b229), [XRPL 19678B95…](https://testnet.xrpl.org/transactions/19678B95D688E9683135C01B22842A7D8A6A3F91D6C59DD926350B413F0B2CDB) |
| BNB Chain: our test USDT deployed on BSC testnet. A real 9.69 tUSDT transfer was authorized by the watcher after 3 confirmations | [token 0xcf00d3d4…](https://testnet.bscscan.com/address/0xcf00d3d4e89e0a2fbe7d64c2e45cf9a18e9b030a), [transfer 0xe6b1aa0e…](https://testnet.bscscan.com/tx/0xe6b1aa0ee04e62b6c4f8972b27f86535adf27c79381c4f3bf65b6a023b672c2b) |
| Multi-currency, end to end: a EUR payer paid Ah Seng (SGD) €9.05 by card, settled as exactly S$12.50 through two pools, then refunded in EUR | [settle 1061AE83…](https://testnet.xrpl.org/transactions/1061AE83742CA9549E46E3CDD1EA36A5154B1110DE46E093418892AE9C0AF4FE), [refund F3662F80…](https://testnet.xrpl.org/transactions/F3662F809CAB4A39C95BB69077B629A4FF4A0FF030FD8F2CB27B22797D3B639C) |
| A USD payer paid a Berlin café (EUR) US$10.92, delivered as exactly €10.10; the café then withdrew €5.00 to an IBAN (simulated SEPA payout) | [settle 63FE43FD…](https://testnet.xrpl.org/transactions/63FE43FDE27FDC849DA207A94E005552F127EDD666CC730B914CE9B6BB5D8833), [withdrawal DA37ED5A…](https://testnet.xrpl.org/transactions/DA37ED5ABD292DAE38AD7B1E4A4A3BF9273F9193761167A6B708B517393B1FA3) |

The BNB demo script settles with the mock XRPL engine. The deployed worker settles BNB payments on real XRPL once its BNB variables are set.

## What's real and what's simulated

| Piece | In this build | In production |
|---|---|---|
| Agent, iMessage App cards, voice | Real: Photon Spectrum, Claude, ElevenLabs | Same, on a dedicated Photon line |
| Card payments | Stripe sandbox, real Apple Pay sheet | Stripe live, one acquiring entity per payer region |
| XRPL settlement, AMM, Credentials, custodial balances | Real, on XRPL testnet | Mainnet with regulated custody |
| RLUSD, XSGD, EUR stablecoins | Test tokens we issue with the same codes | Ripple's RLUSD, StraitsX's XSGD, a regulated euro token on XRPL |
| BNB and AUSD pay-ins | Real, on BSC testnet and Base Sepolia | Mainnet USDT / AUSD |
| Withdraw to own XRPL wallet | Real | Same |
| Withdraw to bank | Real XRPL redemption payment, then a **simulated** payout: StraitsX-shaped for SGD (FAST), SEPA-shaped for EUR (labeled in the UI) | StraitsX payouts API for SGD (needs a business account); a licensed SEPA partner for EUR |

## Design decisions

- **Payers are charged in their own currency.** Charging a US card in SGD triggers the bank's foreign transaction fee and Stripe's conversion fee. We charge USD and let XRPL do the one currency change. See [payments-stripe.md §1a](docs/specs/payments-stripe.md).
- **The stablecoin rails are the cheap path.** Card payments cost about 3% somewhere no matter who absorbs it. The BNB and AUSD lanes have no card fees at all, so they're the lanes we lead with. The fee reasoning is in [payments-stripe.md §8](docs/specs/payments-stripe.md).
- **The agent never moves money.** Money-moving tools only create a pending action. A 👍 tapback, a card button or a web step-up confirms it, and ordinary code calls the worker.
- **Credit only `delivered_amount`.** XRPL partial payments make `Amount` untrustworthy. Every settlement checks that delivered equals the amount owed before crediting the ledger.
- **Every money handler is idempotent.** Status changes are compare-and-set, ledger entries are unique on `(kind, ref)`, webhooks and chain events are claimed once, and XRPL transactions carry an InvoiceID.
- **Multi-step changes run in one Postgres transaction.** Approving a withdrawal re-checks the balance and places the hold atomically, and settling a payment credits the ledger and marks the invoice paid together. That's why `@rove/db` uses Postgres directly (postgres.js over Supabase's pooler) rather than the REST client.
- **Least privilege.** The web app on Vercel holds no signing keys; it quotes with public addresses only. Only the worker signs XRPL, BSC and Base transactions. Bank numbers go from our form straight to the payout partner, and we store a beneficiary id and the last 4 digits.
- **Currency is data.** A registry ([`currencies.ts`](packages/shared/src/currencies.ts)) defines each currency's stablecoin, decimals, payer rails, payout partner and withdrawal limits. USD, SGD and EUR are live on testnet for both payers and merchants. INR, AUD and BRL are listed as planned with what each still needs. Adding a currency means a registry entry, an issuer, a pool and a payout partner. See [corridors.md](docs/specs/corridors.md).

## Architecture

| Part | Runs on | Does |
|---|---|---|
| `apps/web` | Vercel (Next.js) | The pages cards open (`/pay`, `/m`, `/r`, `/setup`, `/bank`, `/w`, `/confirm`, `/shop`), plus the public, merchant and webhook APIs |
| `apps/worker` | Railway (Hono, 1 replica) | Settlement poller, refunds, the withdrawal pipeline, BNB watcher, AUSD relayer, reconciler, event outbox to the agent |
| `apps/agent` | Railway | Photon Spectrum runtime (iMessage), Claude tool loop, onboarding, pending actions, reminders, voice |
| `packages/db` | Supabase Postgres | Schema plus the typed `Db` interface every service uses |
| `packages/xrpl` | (library) | The XRPL engine: quote, settle, merchant accounts, Credentials, refund, sweep, wallet withdrawals, balances, testnet seed |
| `packages/shared` | (library) | Contracts: domain types, zod API schemas, events, currency registry, mocks |
| `packages/imessage-apps` | (library) | iMessage App card builders, the presenter that edits cards in place, QR and sticker images |

Request flows and sequence diagrams: [docs/01-architecture.md](docs/01-architecture.md). Every HTTP route and event: [docs/02-contracts.md](docs/02-contracts.md).

## Hackathon tracks

| Track | What Rove uses |
|---|---|
| Most Technically Impressive | One agent for both sides of a payment, cards edited in place, human-confirmed money movement, a double-entry ledger reconciled against XRPL, four payment rails settling into one ledger |
| Ripple | Issued tokens and trust lines, AMM pools, cross-currency path payments (incl. 2-hop), `delivered_amount` accounting, InvoiceID, Credentials (XLS-70), custodial accounts, redemption sweeps, self-custody withdrawals |
| YZi Labs | Stablecoin merchant checkout. USDT pay-in on BSC testnet with per-payment HD deposit addresses and a confirmation-counting watcher; our tUSDT is deployed on BSC testnet |
| Agora (AUSD) | Gasless AUSD payments via ERC-3009, relayed by Rove (customers need no gas); an x402 v2 developer endpoint so software agents can pay invoices too |
| ElevenLabs | Voice notes in (speech-to-text) and spoken answers out |

## Run it locally

Requirements: Node 20+, pnpm 10 (`corepack enable`), a Supabase project, a Stripe test or sandbox account, and the Stripe CLI for webhooks.

```bash
pnpm i
cp .env.example .env              # fill in: DATABASE_URL, Stripe keys, INTERNAL_SECRET, TOKEN_SECRET, WALLET_ENCRYPTION_KEY
pnpm --filter @rove/db migrate    # applies packages/db/schema.sql (safe to re-run)
pnpm seed                         # XRPL testnet: issuers, treasury, AMM pools, demo merchant; writes .env.seed (merge it into .env)
pnpm --filter @rove/db seed:demo  # demo shop "ahseng" with menu and contacts
pnpm dev                          # web :3000, worker :4001, agent :4002
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

To work without the XRPL testnet or Photon, set `USE_MOCK_SETTLEMENT=1`, `USE_MOCK_CARDS=1` and `USE_TERMINAL_PROVIDER=1` (the agent then also reads from your terminal).

Checks and smoke tests:

```bash
pnpm check                                                  # typecheck + every unit test (PGlite in-process Postgres, no credentials)
pnpm --filter @rove/xrpl settle:demo                        # one real testnet settlement
pnpm --filter @rove/xrpl corridors:demo                     # EUR/USD/SGD corridors on testnet
pnpm --filter worker exec tsx scripts/e2e-smoke.ts ahseng   # card sale + withdrawal on the real stack
pnpm --filter worker exec tsx scripts/e2e-corridors.ts      # EUR and USD payers into SGD and EUR shops, plus a EUR withdrawal
pnpm --filter worker withdraw-smoke ahseng 10               # withdrawal pipeline on mocks
pnpm --filter web exec tsx scripts/x402-agent-pay.ts <invoice code> [base url]   # an agent pays through x402
```

Every environment variable is documented in [`.env.example`](.env.example). Deploying the worker on Railway is covered in [docs/05-dev-setup.md](docs/05-dev-setup.md).

## Limits

- The StraitsX bank payout is simulated. StraitsX API access isn't self-serve.
- The stablecoins are test tokens we issue. Real XSGD and RLUSD exist on XRPL mainnet, but we didn't find testnet issuers for them.
- Our Stripe sandbox is a US account, so EUR and SGD charges are converted to USD by Stripe. Production needs an acquiring entity per payer region.
- Refunds on the BNB and AUSD lanes do the XRPL and ledger part automatically. Sending tokens back to the payer's wallet is a manual, logged step.
- The worker keeps per-merchant ordering in memory, so it runs as one replica. The database's compare-and-set keeps money safe even if that's violated.
- WhatsApp was dropped. iMessage is the only channel.
- Euro bank payouts go through a simulated SEPA partner. USD merchants have no bank payout partner yet, so they withdraw to an XRPL wallet.
- Daily windows (withdrawal daily limit, the 21:00 auto-withdraw, the day summary) use Singapore time for every merchant.
- A merchant can't change currency after their XRPL account exists; the API refuses it rather than migrating the balance.

## Repo map

```
apps/web         Next.js pages + API routes (Vercel)
apps/worker      settlement, refunds, withdrawals, BNB watcher, AUSD relayer, reconciler (Railway)
apps/agent       iMessage agent: Photon runtime, Claude tools, onboarding, voice (Railway)
packages/db      Postgres schema + typed queries
packages/xrpl    XRPL engine + testnet seed and demo scripts
packages/shared  contracts, currency registry, mocks
packages/imessage-apps   card builders, presenter, QR images
docs/            overview, architecture, contracts, specs per component
tasks/           per-person task lists and the integration log
```
