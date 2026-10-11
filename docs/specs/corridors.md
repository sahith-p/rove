# Spec · Corridors: any currency that has a stablecoin

Owner: **Nithya** · Code: `packages/shared/src/currencies.ts` (registry), `packages/xrpl/**` (engine + seed), `packages/xrpl/scripts/corridors-demo.ts` · Contracts: `Currency`, `CurrencyZ`, `MerchantCurrencyZ`, `Quote.pay/sendMax`, `SettlementEngine.quote({ from })` / `settle({ from, sendMax })` (changelog in docs/02-contracts.md)

**Requirement (product):** Rove works with any currency that has a stablecoin version, on the merchant side and on the payer side, with no card-network FX.

**For judges, in one line:** "Pay in your own currency; the merchant gets theirs; one market-rate stablecoin swap on XRPL, no card FX."

## 1. The model

```
Payer pays in THEIR currency                  Rove treasury on XRPL                      Merchant keeps THEIR currency
(card charged in that currency, or that   →   float of the payer's stablecoin    →      custodial account holding
 currency's stablecoin from a wallet)          (RLUSD, XSGD, EUR, …)                     their stablecoin (XSGD, EUR, …)
                                                          │
                                ONE XRPL Payment, market rate, through the RLUSD hub:
                                  same currency      EUR → EUR                  (direct, no swap)
                                  USD on one side    RLUSD → EUR                (1 AMM)
                                  anything else      EUR → RLUSD → XSGD         (2 AMMs, still one Payment)
```

- The card leg never crosses a currency (payments-stripe.md §1a): a German card is charged in EUR, a US card in USD, a Singapore card in SGD. The card network never converts anything, so there is no foreign transaction fee and no DCC markup.
- The only currency change is **one stablecoin-to-stablecoin swap at the market rate** inside a single XRPL Payment. The pools charge their fee (0.03% on our testnet pools, `TradingFee 30`). It is already included in the quote.
- **RLUSD is the hub.** Every other enabled currency has one AMM pool against RLUSD, so N currencies need N−1 pools (not N²), and any pair is at most two hops. `ripple_path_find` finds the route; the engine falls back to the explicit hub path (`hubPaths()`) and to `amm_info` math when path finding is unavailable.
- **Credit only `delivered_amount`.** Every settlement delivers exactly the local amount (`Amount` = local, no `tfPartialPayment`) or fails. `SendMax` caps what the payer-currency float can spend.

### Engine contract (SettlementEngine)

| Call | Meaning |
|---|---|
| `quote({ local, from? })` | What the `from` float (default USD) spends to deliver exactly `local`. `pay` = that amount rounded **up** to the payer currency's minor unit; `sendMax` = `pay` × 1.01 rounded up; `rate` = local per 1 `from` (4 dp, floored). `usd` / `sendMaxUsd` are always filled with the USD route, so USD-only callers see no change. Same currency: `pay = sendMax = local`, `rate 1.0000`. Valid 60 s. |
| `settle({ paymentId, merchantAddress, local, sendMaxUsd, from?, sendMax? })` | One treasury → merchant Payment, `InvoiceID = sha256(paymentId)`, idempotent per id. A cross-currency settlement from a non-USD float needs `sendMax` (= `quote.sendMax`). From USD, `sendMaxUsd` still works. It pre-flights the path and raises `XrplPathError` (re-quote) instead of burning a fee when the pools moved past SendMax. |
| `createMerchantAccount({ merchantId, currency? })` | Trust lines to the merchant currency's stablecoin + RLUSD (default SGD). |
| `balance({ merchantAddress, currency? })` | That stablecoin's trust-line balance (default SGD). |
| `refund` / `sweepToRedemption` / `sendToWallet` | Same-currency payments in `local.currency`. The token comes from the `local` Money they receive. |

## 2. The registry (`packages/shared/src/currencies.ts`)

Each entry has: `code` (ISO 4217), `name`, `decimals`, `symbol`, `countries` (ISO 3166-1), `phonePrefixes` (E.164 country codes), and `stablecoin` (`xrplCode`, `issuerEnv`, `realWorld`, `status: "live-on-testnet" | "planned"`), or `null`. It also has `payout` (the partner id, or null), `payerRails` (`card` | `stablecoin` | `upi` | `pix`), and an honest `note`. Phase B added (optional) `defaultCountry` (the merchant country when onboarding doesn't send one: SGD → SG, USD → US, EUR → DE) and `limits` (`withdrawalMin`, `withdrawalStepUpAbove`, `withdrawalDailyMax`, `fixedQrMax`; every enabled currency has them), with helpers `currencyLimits`, `defaultCountryFor`, `payoutPartnerIdFor` and, in domain.ts, `withdrawalLimitsFor` / `fixedQrMaxFor`.

| Limits | Withdrawal min | Step-up above | Daily max | Fixed-QR cap |
|---|---|---|---|---|
| SGD (= `WITHDRAWAL_LIMITS`) | S$1.00 | S$200.00 | S$2,000.00 | S$500.00 |
| USD | US$1.00 | US$150.00 | US$1,500.00 | US$400.00 |
| EUR | €1.00 | €150.00 | €1,500.00 | €350.00 |

`Currency` is the set of **enabled** codes, meaning those with `status: "live-on-testnet"`. `CurrencyZ`, `DECIMALS` and the `format()` symbols derive from it. Helpers: `currencyForPhone(e164)` (longest country-code match, enabled or planned), `currencyForCountry(cc)`, `enabledCurrencies()`, `allCurrencies()`, `isMerchantCurrency(code)`, `isCurrency(code)`, `getCurrency(code)`, `currencyInfo(code)`, and `payerCurrencyFor({ requested, phone, country })`. The last one picks an explicit enabled choice first, then the phone's currency, then the country's, and falls back to USD. Planned currencies such as INR fall back to USD.

| Code | Stablecoin on XRPL (testnet stand-in → production) | Status | Payout partner | Payer rails | Notes |
|---|---|---|---|---|---|
| **SGD** | `XSGD` → XSGD by StraitsX (MAS-licensed; on XRPL since May 2025) | live-on-testnet | `straitsx` (simulated in the demo) | card, stablecoin | The original corridor |
| **USD** | `RLUSD` → RLUSD by Ripple | live-on-testnet | none chosen | card, stablecoin | **The hub**, and the fallback payer currency |
| **EUR** | `EUR` (plain ISO code, issued by Rove) → a MiCA-regulated euro e-money token issued on XRPL, e.g. Schuman Financial's EURØP (native XRPL integration announced by Ripple on 22 May 2025) | live-on-testnet | `sepa`: SEPA-shaped (IBAN beneficiaries, SEPA Instant), simulated in the demo; production partner not chosen | card, stablecoin | The stand-in deliberately doesn't borrow a real token's ticker |
| INR | none: no INR stablecoin on XRPL that we know of | planned | none | upi | Needs a licensed Indian partner: UPI for payers, bank/UPI payouts for merchants, float stays in USD |
| AUD | `AUDD` → AUDD by Novatti (live on XRPL per Ripple, 13 June 2023) | planned | none | card, stablecoin | Needs the stand-in + pool + an AUD payout partner |
| BRL | `BBRL` → BBRL by Braza Group (launch on XRPL announced by Ripple, 19 Feb 2025; institutional clients first) | planned | none | card, stablecoin | Needs the stand-in + pool, a BRL payout partner, and Pix later |

Sources for the real tokens: Ripple press releases [EURØP on XRPL](https://ripple.com/ripple-press/euro-stablecoin-on-xrp-ledger/) and [BBRL on XRPL](https://ripple.com/ripple-press/braza-group-announces-launch-of-bbrl-stablecoin-on-the-xrp-ledger/), and Ripple Insights, [AUDD on XRPL](https://ripple.com/insights/the-next-evolution-in-global-payments-novatti-brings-stablecoins-to-the-australian-market/). These are announcements; before going live, confirm each token's issuer address, redemption terms and on-ledger liquidity. On testnet, every token is a stand-in that Rove issues.

## 3. Testnet setup (`pnpm seed`, idempotent)

For every enabled currency: an issuer (`AccountSet asfDefaultRipple` **before** any trust line), trust lines from TREASURY / LP / REDEMPTION, and a treasury float of 5,000 (topped up below 2,500). For every non-USD currency there is one AMM pool against RLUSD (`HUB_POOLS` in `packages/xrpl/src/setup.ts`):

| Pool | Created at | Depth | Notes |
|---|---|---|---|
| RLUSD/XSGD | 10,000 / 12,900 originally | deepened with a **two-asset `AMMDeposit`** to ≈1,000,000 RLUSD / 1,281,000 XSGD | `tfTwoAsset` doesn't move the price, so it stays where earlier demos left it (≈1.281 SGD per USD, not 1.29). A S$45 settlement now moves it ≈0.007% (it was ≈0.7%). |
| RLUSD/EUR | 1,080,000 / 1,000,000 (1.08 USD per EUR) | same | A €10 settlement moves it ≈0.002% |

A pool holding less than 500,000 RLUSD is deepened again on the next seed run. Demo merchants: `ahseng` (SGD, `DEMO_MERCHANT_*`) and `cafe-berlin` (EUR, `XRPL_MERCHANT_CAFE_BERLIN_*`), each with a Credential. The seed adopts accounts already in the environment (`ROVE_DOTENV`), so a fresh state file never creates duplicates. A second run submits nothing.

New env vars (`.env.example`): `XRPL_ISSUER_EUR`, `XRPL_ISSUER_EUR_SEED`, `XRPL_AMM_ACCOUNT_EUR`, `XRPL_MERCHANT_CAFE_BERLIN_ADDRESS`, `XRPL_MERCHANT_CAFE_BERLIN_SEED_ENC`. The engine reads each issuer from the registry's `issuerEnv`. It also accepts `XRPL_ISSUER_<CODE>`, and the old `XRPL_USD_ISSUER` / `XRPL_SGD_ISSUER` names keep working.

Testnet accounts: EUR issuer `rKo7EC7Y5MHri4BanjoBLqPXbJPU6UK2j`, RLUSD/EUR AMM `rNtp7f7ZJudmZecMxuM6XnxwJ3x1jZJ4AW`, RLUSD/XSGD AMM `rKoDS79hSMVKo4qU5ozeJx4hkFMGpDyrnw`, cafe-berlin `rGheZs4JF12rHYSNubKzKwZUJymKQCpwSB`.

## 4. Adding a currency (checklist)

1. **Registry entry** in `currencies.ts`: code, decimals, symbol, countries, phone prefixes, `stablecoin` (XRPL code, `issuerEnv`, the real token with a primary source, `status`), `payout`, `payerRails`, `note`. Set `status: "live-on-testnet"` only when steps 2–3 are done; that flips it into `Currency` / `CurrencyZ` everywhere. Adding a value to the `Currency` union is a contract change, so add a changelog row.
2. **Issuer**: the seed creates it from the registry (`<issuerEnv>` / `<issuerEnv>_SEED`), with DefaultRipple first, plus trust lines and the treasury float. On mainnet, use the real issuer's address in `<issuerEnv>` and skip minting.
3. **Pool**: add a `HUB_POOLS` entry (starting amounts at the market rate, deep enough that demo tickets barely move it). On mainnet, check the real RLUSD/<token> AMM or order-book depth; a thin pool means a bad rate, so you may need to seed liquidity or bring in a market maker. Add the rate to the mock (`PER_USD` in `settlement.mock.ts`).
4. **Payout partner**: a licensed partner that redeems the stablecoin and pays the local bank rail, behind `PayoutPartner`, with its id in `payout`. It also needs a bank-account shape: a `BankAccountType` (PayNow/bank for SGD, `iban` for EUR today) mapped to the partner in `BANK_ACCOUNT_PARTNER` (payouts.ts), plus an `AddBankAccountReq` member if the shape is new, and the partner registered in `createMockPayoutPartners` / the real router. Add `limits` and `defaultCountry` to the registry entry too. Until then, merchants can still withdraw to their own XRPL wallet.
5. **Payer rail**: `card` works as soon as Stripe supports the currency (in production, use a Stripe entity in that region to avoid Stripe's own conversion fee); `stablecoin` needs a wallet lane for that token; local rails (UPI, Pix) need a licensed partner.
6. Run `pnpm seed`, then `pnpm --filter @rove/xrpl corridors:demo` (add a corridor for the new currency).

Non-2-decimal currencies (JPY 0, KWD 3) work in `money.ts`, the quote math (rates, rounding) and `deliveredMoney()`. No test covers one yet; add one with the first such currency.

## 5. What's live on testnet (evidence)

`pnpm --filter @rove/xrpl corridors:demo` (with `ROVE_DOTENV` pointing at the env that holds the seeds), 11 Oct 2026. Every corridor is ONE Payment, and every `delivered_amount` is exact:

| Corridor | Quote | Route (pools used) | Delivered | Tx |
|---|---|---|---|---|
| a) EUR payer → ahseng (SGD) | €9.05 (SendMax €9.15) → S$12.50 at 1.3812 | EUR → RLUSD → XSGD (RLUSD/EUR + RLUSD/XSGD) | 12.50 XSGD | [F9A8BF3F…](https://testnet.xrpl.org/transactions/F9A8BF3F40D1B309EE53D0F89C2B40A555EF84C443B7133EA6E21500E98D7B66) |
| b) USD payer → cafe-berlin (EUR) | US$10.27 (SendMax US$10.38) → €9.50 at 0.9250 | RLUSD → EUR (RLUSD/EUR) | 9.50 EUR | [2474B08F…](https://testnet.xrpl.org/transactions/2474B08F9BBA69DC0F7A0BA4CF4E58A40C19094BA2DC7E5C5EA221C931044B5C) |
| c) SGD payer → cafe-berlin (EUR) | S$5.82 (SendMax S$5.88) → €4.20 at 0.7216 | XSGD → RLUSD → EUR (both pools) | 4.20 EUR | [1B272AC5…](https://testnet.xrpl.org/transactions/1B272AC58B1074CAF953876DDBECAC5E21F966268A6880FE0F786229D158E435) |
| d) EUR payer → cafe-berlin (EUR) | €3.00 → €3.00 (no swap) | direct | 3.00 EUR | [5C78BF0D…](https://testnet.xrpl.org/transactions/5C78BF0D7BCA2B7A7ED276CD88FE12F41A0A2B33FEE232FBEF55393CAD05F5B8) |

The USD → SGD reference quote (S$12.50) was 1.2794 before and after the run: no visible drift. `settle:demo` (G1) and `engine:demo` still pass unchanged.

### 5b. Phase B: the whole app, live (11 Oct 2026)

`ROVE_DOTENV=<main .env> pnpm --filter worker exec tsx scripts/e2e-corridors.ts [a] [b] [c]` runs the real web routes (checkout, Stripe webhook, bank accounts) and the real worker code against Supabase, the Stripe sandbox and XRPL testnet. Each step asserts the ledger and reconciles against XRPL. Events are recorded in memory, so nobody gets a text.

| Run | What happened | Evidence |
|---|---|---|
| a) EUR payer → `ahseng` (SGD) | One-time code S$12.50 (DB prices) → `POST /api/checkout { payCurrency: "EUR" }` → **€9.05** at 1.3812 S$/€ (SendMax €9.15, stored as `quote_from/pay/send_max`) → Stripe PaymentIntent `pi_3UPVr92Nmb09925b0rHobsBR` in **eur** (905), confirmed with `pm_card_visa` → signed webhook → worker settles from the EUR float. ONE Payment, SendMax in EUR, through RLUSD/EUR + RLUSD/XSGD, `delivered_amount` exactly **12.50 XSGD** → ledger +S$12.50 → reconcile ✓ S$34.50. Then a full refund via the worker: XSGD back to the treasury and Stripe refund `re_3UPVr92Nmb09925b0tWINiu4` of **905 eur** (the charge currency) → reconcile ✓ S$22.00 (ahseng's balance before the run) | settle [1061AE83…](https://testnet.xrpl.org/transactions/1061AE83742CA9549E46E3CDD1EA36A5154B1110DE46E093418892AE9C0AF4FE) · refund [F3662F80…](https://testnet.xrpl.org/transactions/F3662F809CAB4A39C95BB69077B629A4FF4A0FF030FD8F2CB27B22797D3B639C) |
| b) USD payer → `cafe-berlin` (EUR) | Fixed-QR basket 2 × Flat white + 1 × Croissant = €10.10 (DB prices) → **US$10.92** at 0.9249 €/US$ (SendMax US$11.03) → PaymentIntent `pi_3UPVrY2Nmb09925b0YDrX881` in usd (1092) → webhook → ONE Payment, SendMax in RLUSD, through RLUSD/EUR, `delivered_amount` exactly **10.10 EUR** → ledger +€10.10 (first sale) → reconcile ✓ €10.10 | [63FE43FD…](https://testnet.xrpl.org/transactions/63FE43FDE27FDC849DA207A94E005552F127EDD666CC730B914CE9B6BB5D8833) |
| c) `cafe-berlin` bank withdrawal | IBAN through `POST /api/me/bank-accounts` (simulated SEPA partner; only last 4 + beneficiary id stored) → €5.00 withdrawal, fee €0.00, to "IBAN ••••3000" → approved (hold) → sweep 5.00 EUR to the redemption account on XRPL → simulated SEPA Instant payout `SCTINST-628624` → completed → ledger hold + debit → reconcile ✓ €5.10 | [DA37ED5A…](https://testnet.xrpl.org/transactions/DA37ED5ABD292DAE38AD7B1E4A4A3BF9273F9193761167A6B708B517393B1FA3) |

Before b), `cafe-berlin`'s XRPL account held €33.40 from the Phase A demo runs with no DB rows, so `seed:demo` created its row and `scripts/demo-reset.ts cafe-berlin` sent the €33.40 back while its ledger was empty ([3B05E9CE…](https://testnet.xrpl.org/transactions/3B05E9CE2E7FFFDBBDC728C7C23245184EF9B974EE59F164182EBA438B0C8527)).

## 6. Honest limits

- On testnet every token is a stand-in we issue. "Market rate" means the rate of our own pools. In production the rate is whatever the real XRPL pools/books offer, and a thin euro pool would mean a worse rate (§4.3).
- Rove has to hold a float in every payer currency and rebalance it. Stripe payouts in EUR are tokenized 1:1 into the euro stablecoin, the same model as USD → RLUSD (payments-stripe.md §1a). Rebalancing isn't built (§7).
- **Stripe:** our sandbox is a US account. It accepts EUR and SGD presentment, so the payer's card is charged in their own currency (no card FX for them), but Stripe converts to USD on its own settlement. That is fine in test mode. Production needs a Stripe entity per region (an EU entity for EUR, a Singapore one for SGD) so Stripe's conversion never applies.
- Bank payouts are simulated for every currency: StraitsX-shaped for SGD, SEPA-shaped for EUR. USD has no payout partner, so USD shops withdraw to their own XRPL wallet.
- The daily windows (withdrawal daily max, auto-withdraw at 21:00, the daily summary) still use the Asia/Singapore day for every shop.
- A shop's currency is fixed once its XRPL account exists (`PUT /api/me/shop` → 409 `currency_locked`). Switching would need a zero balance plus the new trust line.

## 7. Phase B: app wiring

Status as of the `nithya/corridors-phase-b` branch (`CUR-B ·` commits). ✓ = done and tested (unit tests plus the live run in §5b).

- [x] **Checkout** (`apps/web/app/api/checkout`): `payerCurrencyFor({ requested: payCurrency, phone })` picks the payer currency (toggle, then phone, then USD; bnb/ausd stay USD). `quote({ local, from: payerCurrency })`; the charge is `quote.pay`, or the total when payer and shop share a currency. The Stripe PaymentIntent is in that currency, and reuse still keys on the charge currency. `currency_not_supported` is now only returned for registry currencies that aren't enabled (e.g. `payCurrency: "INR"`). Fixed-QR caps are per shop currency. `CheckoutRes.charge` + `quote.rate` (local per 1 payer unit) are exactly what the pay page shows ("€9.05 · S$12.50 at 1.3812 · no card FX fees").
- [x] **Persist the payer route**: `payments.quote_from / quote_pay / quote_send_max` (idempotent adds in schema.sql, applied to Supabase), mapped to `Quote.pay` / `sendMax` and back.
- [x] **Worker settle** (NI-C2): `settle({ …, from: charge currency, sendMax: quote.sendMax })`. A path error, an expired quote, or a stored quote made for another float re-quotes with `quote({ local, from })`. Same-currency settles need no quote. A bounced withdrawal still returns from `merchant.currency`.
- [x] **Refunds**: Stripe is refunded in the charge currency (proportional for partial refunds, rounded down). Verified with an EUR charge in unit tests and live (§5b a).
- [x] **Worker onboarding** (`apps/worker/src/merchants.ts`): `createMerchantAccount({ currency })`, so an EUR shop gets EUR + RLUSD trust lines. `InternalCreateMerchantReq.country` is optional.
- [x] **Balance + reconciler**: the reconciler and `GET /api/me` read `balance({ currency: merchant.currency })`.
- [x] **Merchant country**: `packages/db` stores and returns `merchants.country`. When onboarding doesn't send one, it defaults to the currency's registry `defaultCountry`, and it follows a currency change made before go-live.
- [x] **Env / demo data**: `@rove/db seed:demo` also upserts `cafe-berlin` (EUR, DE, live, XRPL account from `XRPL_MERCHANT_CAFE_BERLIN_*`) with a 4-item EUR menu. Local `.env` has `XRPL_ISSUER_EUR`. **Not done here:** the deploy envs (Vercel web + Railway worker) still need `XRPL_ISSUER_EUR`; that's the deploy owner's step.
- [~] **Currency changes after go-live**: they're rejected once the XRPL account exists (409 `currency_locked`). Allowing a switch at zero balance with an added trust line isn't built.
- [x] **Withdrawals per currency**: limits come from the registry (`limits`; `WITHDRAWAL_LIMITS` still works for SGD), and the fee and messages are in the shop's currency. The payout partner comes from the registry's `payout` field via `routePayoutPartners`: SGD → StraitsX-shaped mock (FAST ref), EUR → SEPA-shaped mock (SCTINST ref), both labeled simulated. USD → `no_bank_payout`, wallet only. Bank accounts: an `iban` variant of `AddBankAccountReq` (IBAN in `accountNumber`, checksum-validated; changelog row "proposed"). The route only accepts account types that can receive the shop's currency. Wallet withdrawals already worked in any currency.
- [ ] **Pages** (Sahith): the toggle over every enabled currency shipped. Still to do: the `/bank` IBAN form for EUR shops (type `"iban"`, the IBAN in `accountNumber`, optional `bankName`; show it only when `GET /api/me` says `merchant.currency` is EUR; `422 account_type_not_supported` / `bank_payouts_unavailable` messages are ready to show) and the `accountLabel()` case for `type: "iban"` ("IBAN ••••3000"). Amounts should go through `format()` everywhere (€).
- [ ] **Agent copy** (Saran): replace the hardcoded "XSGD" / "S$" with the merchant currency's token and symbol (`currencyInfo(c).stablecoin.xrplCode`, `format()`). The daily summary should use the merchant's timezone. `withdrawal.updated.amount` and every worker refusal message are already in the shop's currency.
- [ ] **Stripe**: production presentment per region (an EU entity for EUR) so Stripe's own conversion never applies. Not code, documented in §6.
- [ ] **Treasury float rebalancing**: a script idea, not built. A daily job reads each float (`balance` of the treasury per enabled currency) and compares it with a target (e.g. 3 days of that currency's charges). It alerts below 50%. To refill, it tokenizes the matching Stripe payout (EUR payouts → mint/buy the euro token; on testnet, an issuer Payment) or swaps the surplus float through the RLUSD hub with a single `Payment` to the treasury itself (SendMax in the surplus token).
- [ ] **Local payer rails via partners later**: UPI (INR) and Pix (BRL) as `payerRails`. INR merchants need a licensed Indian partner, since there's no INR stablecoin on XRPL.
- [ ] **Docs**: settlement-xrpl.md §2 still describes the original 10,000 / 12,900 pool; update it to the deep pools and the per-currency seed. CLAUDE.md's "XSGD balance" rule should read "the merchant's stablecoin balance" (not this branch's file).
