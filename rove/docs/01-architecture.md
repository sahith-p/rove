# 01 · Architecture

Three deployables, one database, two ledgers (XRPL for funds, Postgres for state). Each deployable has one owner.

| Deployable | Host | Owner | Why it's separate |
|---|---|---|---|
| `apps/web` (Next.js): the minimal web app + API | Vercel | Sahith (pages), Nithya (`/api/*` except actions), Saran (`/api/actions`) | Public HTTPS: Apple Pay, pages opened from messages |
| `apps/worker` | Railway | Nithya | Persistent XRPL + BSC connections; settlement, refunds, withdrawals |
| `apps/agent` | Railway | Saran (runtime, Claude, tools), Sahith (card presenter module) | Holds the Spectrum stream (iMessage + WhatsApp); long Claude turns |
| Supabase Postgres | Supabase | Nithya | State machines, ledger, menu, contacts, invoices |
| XRPL testnet | — | Nithya | Treasury, issuers, AMM, merchant custodial accounts, redemption account |
| BNB Chain testnet | — | Nithya | Test USDT, per-payment deposit addresses |

## System

```mermaid
flowchart LR
  subgraph People
    MER[Merchant<br/>iMessage / WhatsApp]
    CUS[Customer<br/>iMessage / WhatsApp / camera]
  end
  MER <--> PH[Photon Spectrum]
  CUS <--> PH
  PH <--> AG[agent<br/>Claude + tools]
  AG --> CL[Claude API]
  AG --> EL[ElevenLabs]
  AG <--> DB[(Supabase)]
  AG -- create/execute withdrawals,<br/>refunds, merchant accounts --> WK[worker]
  CUS -- taps pay card / scans QR --> WEB["web: /pay /m /r"]
  MER -- taps setup / bank / withdrawal cards --> WEB2["web: /setup /bank /w /shop /confirm"]
  WEB -- Apple Pay --> ST[Stripe test mode]
  WEB -- USDT via Privy --> BSC[(BNB Chain testnet)]
  ST -- webhook --> API["web /api"]
  WEB --> API
  WEB2 --> API
  API <--> DB
  API -- /internal/settle --> WK
  BSC -- Transfer events --> WK
  WK <--> DB
  WK <--> XRPL[(XRPL testnet)]
  WK -- payouts --> PP[Payout partner<br/>simulated StraitsX]
  WK -- /internal/events --> AG
  API -- /internal/events --> AG
```

Rules of the road:
- **Postgres is the source of truth for state; XRPL is the source of truth for funds.** The reconciler checks that ledger `available + held` = XSGD on each merchant's account.
- **Only the worker signs XRPL/BSC transactions** and calls Stripe refunds and the payout partner.
- **Only the agent talks to Photon.** Worker and web emit events; the agent turns them into messages.
- **Status changes are compare-and-set**, and every money handler is idempotent on a named key.
- **Bank numbers never enter the chat or our DB.** The bank form sends them to the payout partner; we keep `beneficiaryId` + last 4.

## Flow 1: merchant onboarding over iMessage (uses the iMessage App API)

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant (iMessage)
  participant A as agent
  participant W as web (/setup)
  participant K as worker
  M->>A: "hi"
  A->>M: welcome + Rove contact card (nativeContactCard): "save me"
  A->>M: "What's your shop called?"
  M->>A: "Ah Seng Chicken Rice"
  A->>M: poll("What do you sell?", Hawker food, Drinks, Groceries, Other)
  M->>A: votes Hawker food
  A->>M: setup card app(/setup?t=…, live): "add your menu here, or just text it to me"
  M->>W: edits menu inside Messages (PUT /api/me/menu)
  W->>A: event shop.updated
  A->>M: edit(setup card) → "Ah Seng Chicken Rice · 4 items ✓"
  A->>K: POST /internal/merchants (custodial XRPL account, trust lines, Credential)
  K->>A: event merchant.live
  A->>M: effect("You're live!", confetti) + fixed QR sticker PNG
  A->>M: bank card app(/bank?t=…): "add your bank so you can withdraw"
```
WhatsApp merchants get the same steps as links and numbered replies (no polls, effects or in-place edits).

## Flow 2: invoice by text (merchant → customer)

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant
  participant A as agent
  participant C as Customer (iMessage)
  participant W as web (/pay)
  participant S as Stripe
  participant K as worker
  participant X as XRPL
  M->>A: "invoice Maya 2 chicken rice and a barley"
  A->>A: create_invoice → menu lookup → S$12.50, code K7Q2MX
  A->>C: invoice card app(/pay/K7Q2MX, live): "Ah Seng Chicken Rice sent you a request for S$12.50"
  A->>M: "Sent to Maya ✓ (S$12.50)"
  C->>W: opens card inside Messages → POST /api/checkout → Apple Pay
  S->>W: webhook payment_intent.succeeded → payment authorized
  W->>K: /internal/settle
  K->>X: Payment treasury→merchant: Amount 12.50 XSGD, SendMax ≤ 9.79 RLUSD (AMM)
  X-->>K: tesSUCCESS, delivered_amount 12.50
  K->>K: payment settled · invoice paid · ledger payment_credit
  K->>A: event payment.settled
  A->>C: edit(invoice card) → "Paid ✓" + receipt card
  A->>M: sale card "S$12.50 from Maya ✓"
```
A one-time QR is the same invoice rendered as a QR image for the merchant to show. A fixed QR is `/m/<shop>`: the customer picks items or types an amount, then the same checkout runs.

## Flow 3: withdrawal to bank (the pipeline; full spec in docs/specs/withdrawals.md)

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant
  participant A as agent
  participant K as worker
  participant X as XRPL
  participant P as Payout partner (simulated StraitsX)
  M->>A: "withdraw everything"
  A->>K: POST /internal/withdrawals {amount:null} → requested, S$118.40, fee S$0, DBS ••••1234
  A->>M: confirm card + "👍 to withdraw S$118.40 to DBS ••••1234"
  M->>A: 👍
  A->>A: claimAction (plain code)
  A->>K: POST /internal/withdrawals/:id/execute
  K->>K: approved · ledger withdrawal_hold
  K->>X: Payment merchant→REDEMPTION, 118.40 XSGD, InvoiceID=sha256(wd_id)
  X-->>K: tesSUCCESS → onchain_settled · ledger withdrawal_debit
  K->>P: createPayout(beneficiaryId, S$118.40, idempotencyKey=wd_id) → payout_pending
  P-->>K: callback completed, FAST-881245
  K->>A: withdrawal.updated (each step)
  A->>M: edit(withdrawal card): On XRPL ✓ → Sent to bank ✓ → In your bank ✓ FAST-881245
```

## Flow 4: BNB Chain pay-in

`POST /api/checkout {method:"bnb"}` → per-payment deposit address → Privy wallet sends test USDT → worker sees `Transfer` (3 confirmations) → payment authorized → same settle step as Flow 2.

## Trust boundaries

| Boundary | Protection |
|---|---|
| Message sender → agent | Persona from the sender's phone; merchant tools only for that merchant's phone; customer tools see only invoices/receipts for that phone |
| Text from strangers (notes, names, contact cards, customer messages) | Data, never instructions |
| Agent → money | No tool moves money; `propose_*` → pending action → human 👍 / YES / card / web → plain-code executor |
| Withdrawals | Funds held in the ledger before anything leaves; first withdrawal, new bank, or > S$200 needs web step-up confirm |
| Bank details | Only on `/bank` (15-min token); sent to the partner; DB stores beneficiary id + last 4 |
| Merchant pages | HMAC session tokens with a scope (setup / bank / shop / withdrawal / sale), short expiry |
| Customer pages | Unguessable invoice codes and payment ids; amounts come from the server, never the URL |
| Stripe webhook | `constructEvent(rawBody)` + `claim("stripe:<id>")` |
| XRPL / BSC | Credit only `meta.delivered_amount`; per-payment deposit addresses; 3 confirmations; `claim()` per tx/log |
| Services | `authorization: Bearer INTERNAL_SECRET`, zod on every body |

## Environments

- **Local:** `pnpm dev` runs web :3000, worker :4001, agent :4002. Stripe CLI forwards webhooks. Photon's **terminal provider** lets you test the agent without a phone.
- **Deployed (from G3):** web on Vercel (stable HTTPS domain registered for Apple Pay), worker + agent on Railway, the same Supabase project.
