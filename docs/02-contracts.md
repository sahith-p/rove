# 02 · Contracts

The contracts let three people and many agents build in parallel. They live in code in `packages/shared/src` and are **frozen after gate G0**. Build against them; use the mocks until the real side passes its gate.

| File | Contract | Implemented by | Consumed by |
|---|---|---|---|
| `money.ts` | `Money` = decimal string + currency; bigint math | (done) | everyone |
| `domain.ts` | Merchant, MenuItem, Contact, Invoice, Payment, Quote, Refund, LedgerEntry, Balance, BankAccount, Withdrawal, PendingAction, AgentMessage, `Recipient` | (types) | everyone; mirrors `packages/db/schema.sql` |
| `api.ts` | zod schemas for every public, merchant and internal route + `ROUTES` | route owners | callers |
| `events.ts` | `EventEnvelope` / `RoveEvent` (worker + web → agent) | Nithya (emits) | Saran (consumes) |
| `settlement.ts` | `SettlementEngine` (XRPL) | Nithya (`packages/xrpl`) | worker, web (quotes, verified badge) |
| `payouts.ts` | `PayoutPartner` (StraitsX-shaped: beneficiaries + payouts) | Nithya (mock for the demo) | worker, web (bank form) |
| `cards.ts` | `CardBuilders`, `CardPresenter` (iMessage App cards, merchants + customers) | Sahith (`packages/imessage-apps`) | agent |
| `links.ts` | Every public URL | (done) | everyone |
| `agent.ts` | Merchant + customer tool names and zod inputs, `AGENT_MODEL` | Saran | evals, web |
| `tokens.ts` | HMAC sign/verify, `MerchantSessionPayload` (scoped), `ConfirmTokenPayload` | (done) | web, agent |
| `mocks/*` | Mock settlement, payouts, console card presenter, fixtures (shop, menu, contact, invoice) | (done) | everyone until gates pass |

## Web app pages (Sahith) and who links to them

| Page | Who opens it | Opened from | Calls |
|---|---|---|---|
| `/pay/[code]` | customer | invoice card, one-time QR | `GET /api/invoices/:code`, `POST /api/checkout`, `GET /api/payments/:id` |
| `/m/[merchantId]` | customer | fixed QR sticker, menu card | `GET /api/shops/:id`, `POST /api/checkout` |
| `/r/[paymentId]` | customer (receipt) / merchant (`?view=merchant&t=`) | receipt card, sale card | `GET /api/payments/:id` |
| `/setup?t=` | merchant | setup card | `GET /api/me`, `PUT /api/me/shop`, `PUT /api/me/menu` |
| `/bank?t=` | merchant | bank card | `POST /api/me/bank-accounts` |
| `/w/[withdrawalId]?t=` | merchant | withdrawal card | `GET /api/withdrawals/:id`, `POST /api/actions/:id/confirm` (step-up) |
| `/confirm/[actionId]?t=` | merchant | confirm card | `POST /api/actions/:id/confirm` |
| `/shop?t=` | merchant | "my shop" card | `GET /api/me` |

## HTTP routes

### Public + merchant (apps/web)

| Route | Owner | Auth | Request → Response |
|---|---|---|---|
| `GET /api/shops/:merchantId` | Nithya | none | → `ShopPublicRes` |
| `GET /api/invoices/:code` | Nithya | none | → `InvoicePublicRes` |
| `POST /api/checkout` | Nithya | none | `CheckoutReq` → `CheckoutRes` |
| `GET /api/payments/:paymentId` | Nithya | none | → `PaymentStatusRes` |
| `POST /api/stripe/webhook` | Nithya | Stripe signature | raw event → 200 |
| `GET /api/me` | Nithya | session (any scope) | → `MeRes` |
| `PUT /api/me/shop` | Nithya | session `setup` | `UpdateShopReq` → 204, emits `shop.updated` |
| `PUT /api/me/menu` | Nithya | session `setup` | `UpdateMenuReq` → 204, emits `shop.updated` |
| `POST /api/me/bank-accounts` | Nithya | session `bank` | `AddBankAccountReq` → `AddBankAccountRes`, emits `bank_account.added` |
| `GET /api/withdrawals/:id` | Nithya | session `withdrawal` / `shop` | → `WithdrawalRes` |
| `POST /api/actions/:actionId/confirm` | Saran | confirm token | `ConfirmActionReq` → `ConfirmActionRes` |

Session = `x-rove-session: <signToken(MerchantSessionPayload)>`, which the page got from its `?t=`.

### Internal (`authorization: Bearer INTERNAL_SECRET`)

| Route | Service · Owner | Request → Response | Caller | Idempotent on |
|---|---|---|---|---|
| `POST /internal/settle` | worker · Nithya | `InternalSettleReq` → 202 | webhook route, BSC watcher | paymentId (status CAS) |
| `POST /internal/refunds` | worker · Nithya | `InternalRefundReq` → `InternalRefundRes` | agent executor | actionId |
| `POST /internal/withdrawals` | worker · Nithya | `InternalCreateWithdrawalReq` → `InternalCreateWithdrawalRes` | agent `propose_withdrawal` | — (creates `requested`) |
| `POST /internal/withdrawals/:id/execute` | worker · Nithya | `InternalExecuteWithdrawalReq` → 202 | agent executor | withdrawal id (status CAS) |
| `POST /internal/merchants` | worker · Nithya | `InternalCreateMerchantReq` → `InternalCreateMerchantRes` | agent onboarding | merchant id |
| `PATCH /internal/merchants/:id/auto-withdraw` | worker · Nithya | `InternalSetAutoWithdrawReq` → 204 | agent executor | — |
| `POST /internal/events` | agent · Saran | `EventEnvelope` → 202 | worker, web API | envelope id |
| `POST /internal/actions/:id/confirm` | agent · Saran | `InternalConfirmReq` → `InternalConfirmRes` | `/api/actions/:id/confirm` | action status CAS |

## Events → what the agent does

| Event | Merchant sees | Customer sees |
|---|---|---|
| `payment.settled` | sale card (+ confetti if `firstSale`) | invoice card edited to "Paid ✓" + receipt card |
| `payment.failed` | one line: "a payment failed; the customer was refunded" | "Payment failed, you weren't charged" |
| `refund.completed` / `failed` | confirm + sale cards edited | "Ah Seng refunded S$12.50" |
| `withdrawal.updated` | withdrawal card edited per step (WhatsApp: message only on completed/failed) | — |
| `merchant.live` | confetti "You're live!" + fixed QR sticker + bank card | — |
| `shop.updated` | setup card edited ("4 items ✓") | — |
| `bank_account.added` | "DBS ••••1234 (AH SENG FOOD PTE LTD) saved ✓" | — |

## Cards (Sahith builds, the agent sends)

| Kind | To | Key | URL |
|---|---|---|---|
| setup | merchant | `setup:<merchantId>` | `/setup?t=…&v=<menuCount>` |
| bank | merchant | `bank:<merchantId>` | `/bank?t=…` |
| shop | merchant | `shop:<merchantId>` | `/shop?t=…` |
| menu | anyone | `menu:<merchantId>` | `/m/<merchantId>` |
| invoice | customer | `invoice:<invoiceId>` | `/pay/<code>?v=<status>` |
| receipt | customer | `receipt:<paymentId>` | `/r/<paymentId>` |
| sale | merchant | `sale:<paymentId>` | `/r/<paymentId>?view=merchant&t=…&v=<status>` |
| withdrawal | merchant | `withdrawal:<withdrawalId>` | `/w/<id>?t=…&v=<status>` |
| confirm | merchant | `confirm:<actionId>` | `/confirm/<actionId>?t=…&v=<status>` |

## Env flags that switch mocks

| Flag | 1 = | Flip to 0 at |
|---|---|---|
| `USE_MOCK_SETTLEMENT` | `createMockSettlement()` | G1 |
| `USE_MOCK_CARDS` | console presenter | G2 |
| `USE_MOCK_PAYOUTS` | simulated StraitsX (stays 1 for the demo, labeled) | never |
| `USE_TERMINAL_PROVIDER` | agent also listens on the terminal | demo |

## Changing a contract

1. PR touching only `packages/shared` + this file's changelog.
2. All three owners approve (CODEOWNERS). Adding an **optional** field: one other owner.
3. Never rename or remove a field after G2.

## Changelog

| Time | Change | Approved by |
|---|---|---|
| G0 | Initial contracts (messaging-first design) | — |
| proposed | Charge the payer in their own currency (no card FX): optional `CheckoutReq.payCurrency`, `CheckoutRes.charge`, `PaymentStatusRes.charge`, `Payment.charge`, `SettlementEngine.settle({ from })`; `payments.charge_amount/charge_currency`. See payments-stripe.md §1a | Nithya (proposer); needs one more owner |
| proposed | Optional `MeRes.reconciled` (the "Ledger ✓ matches XRPL" flag; name matches what SH-C3 `/shop` already reads) · optional `PaymentStatusRes.createdAt/refunded/payerName/merchantVerified` (Sahith 14:20 request) | Nithya (proposer); needs one more owner |
