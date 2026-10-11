# Spec · Corridors: any currency that has a stablecoin

Owner: **Nithya** · Code: `packages/shared/src/currencies.ts` (registry), `packages/xrpl/**` (engine + seed), `packages/xrpl/scripts/corridors-demo.ts` · Contracts: `Currency`, `CurrencyZ`, `MerchantCurrencyZ`, `Quote.pay/sendMax`, `SettlementEngine.quote({ from })` / `settle({ from, sendMax })` (changelog in docs/02-contracts.md)

**Requirement (product):** Rove works with any currency that has a stablecoin version, on the merchant side and on the payer side, with no card-network FX.

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

Each entry has: `code` (ISO 4217), `name`, `decimals`, `symbol`, `countries` (ISO 3166-1), `phonePrefixes` (E.164 country codes), and `stablecoin` (`xrplCode`, `issuerEnv`, `realWorld`, `status: "live-on-testnet" | "planned"`), or `null`. It also has `payout` (the partner id, or null), `payerRails` (`card` | `stablecoin` | `upi` | `pix`), and an honest `note`.

`Currency` is the set of **enabled** codes, meaning those with `status: "live-on-testnet"`. `CurrencyZ`, `DECIMALS` and the `format()` symbols derive from it. Helpers: `currencyForPhone(e164)` (longest country-code match, enabled or planned), `currencyForCountry(cc)`, `enabledCurrencies()`, `allCurrencies()`, `isMerchantCurrency(code)`, `isCurrency(code)`, `getCurrency(code)`, `currencyInfo(code)`, and `payerCurrencyFor({ requested, phone, country })`. The last one picks an explicit enabled choice first, then the phone's currency, then the country's, and falls back to USD. Planned currencies such as INR fall back to USD.

| Code | Stablecoin on XRPL (testnet stand-in → production) | Status | Payout partner | Payer rails | Notes |
|---|---|---|---|---|---|
| **SGD** | `XSGD` → XSGD by StraitsX (MAS-licensed; on XRPL since May 2025) | live-on-testnet | `straitsx` (simulated in the demo) | card, stablecoin | The original corridor |
| **USD** | `RLUSD` → RLUSD by Ripple | live-on-testnet | none chosen | card, stablecoin | **The hub**, and the fallback payer currency |
| **EUR** | `EUR` (plain ISO code, issued by Rove) → a MiCA-regulated euro e-money token issued on XRPL, e.g. Schuman Financial's EURØP (native XRPL integration announced by Ripple on 22 May 2025) | live-on-testnet | none chosen (SEPA partner) | card, stablecoin | The stand-in deliberately doesn't borrow a real token's ticker |
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
4. **Payout partner**: a licensed partner that redeems the stablecoin and pays the local bank rail, behind `PayoutPartner`, with its id in `payout`. It also needs a bank-account shape (`BankAccountType` today is PayNow/FAST-only). Until then, merchants can still withdraw to their own XRPL wallet.
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

## 6. Honest limits

- On testnet every token is a stand-in we issue. "Market rate" means the rate of our own pools. In production the rate is whatever the real XRPL pools/books offer, and a thin euro pool would mean a worse rate (§4.3).
- Rove has to hold a float in every payer currency and rebalance it. Stripe payouts in EUR are tokenized 1:1 into the euro stablecoin, the same model as USD → RLUSD (payments-stripe.md §1a).
- `Quote.pay` / `sendMax` don't persist yet: the DB stores `quote_usd / quote_rate / quote_send_max_usd` (Phase B).
- `WITHDRAWAL_LIMITS`, `BankAccountType` (PayNow/FAST), the daily summary timezone (Asia/Singapore) and some copy ("XSGD") are still Singapore-shaped (Phase B).

## 7. Phase B: app wiring (not in this change)

The app-level work, once the in-flight app tasks land. Each item names where the change goes.

- [ ] **Env**: copy `XRPL_ISSUER_EUR` into the web app and worker envs (public), and `XRPL_MERCHANT_CAFE_BERLIN_*` into the worker env. Have `@rove/db seed:demo` create the `cafe-berlin` row (country DE, currency EUR) from them. Without `XRPL_ISSUER_EUR`, EUR quotes fail with a clear "XRPL_ISSUER_EUR is not set"; SGD/USD are unaffected.
- [ ] **Checkout** (`apps/web/app/api/checkout`): choose the payer currency with `payerCurrencyFor({ requested: payCurrency, phone: payerPhone, country })` (phone prefix, locale/country, toggle), and drop the 400 `currency_not_supported` for enabled currencies. Call `settlement.quote({ local: total, from: payCurrency })` and charge `quote.pay` in that currency on Stripe (`toMinor()` uses the registry's decimals). The BNB and AUSD lanes stay USD.
- [ ] **Persist the payer route**: store `from` (= `charge.currency`), `quote.pay` and `quote.sendMax` on the payment (new `payments` columns in `packages/db`, or derive them from `charge`). Today only the USD fields round-trip.
- [ ] **Worker settle** (NI-C2): `settle({ paymentId, merchantAddress, local, sendMaxUsd: quote.sendMaxUsd, from: payment.charge.currency, sendMax: quote.sendMax })`. Re-quote with `quote({ local, from })` on `XrplPathError`. A bounced withdrawal returns with `from: merchant.currency`.
- [ ] **Worker onboarding** (`apps/worker/src/merchants.ts`): pass `currency: body.currency` to `createMerchantAccount`. **Until then a non-SGD merchant gets an XSGD trust line**, because the engine defaults to SGD.
- [ ] **Balance + reconciler**: `balance({ merchantAddress, currency: merchant.currency })`. CLAUDE.md's "XSGD balance" rule should read "the merchant's stablecoin balance".
- [ ] **Merchant country**: `packages/db/src/map.ts` hardcodes `country: "SG"`; read the column. Onboarding asks for the merchant's country/currency and defaults it from `currencyForPhone(merchant.phone)`.
- [ ] **Currency changes after go-live** (`PUT /api/me/shop` now accepts any enabled currency): allow them only while the balance is zero, and add the new trust line (`createMerchantAccount` with the new currency is idempotent and adds missing lines). Otherwise reject.
- [ ] **Withdrawals per currency**: limits (`WITHDRAWAL_LIMITS` is SGD-named; this needs a per-currency map, a contract change), payout partner from `currencyInfo(c).payout`, and bank-account shapes (IBAN/SEPA for EUR, a contract change to `BankAccountType` / `AddBankAccountReq`). Currencies without a partner offer wallet withdrawals only, or use the simulated mock, labeled.
- [ ] **Pages**: amounts through `format()` (registry symbols). `CurrencyToggle` options from `enabledCurrencies()` (payer's local currency + merchant currency + USD). `localeCurrency()` via `currencyForCountry(<locale region>)`. Pay page line: "€9.05 · S$12.50 at 1.3812 · no card FX fees".
- [ ] **Agent copy**: replace the hardcoded "XSGD" / "S$" with the merchant currency's token and symbol. The daily summary uses the merchant's timezone.
- [ ] **Stripe**: production presentment per region (an EU entity for EUR) so Stripe's own conversion surcharge never applies.
- [ ] **Treasury float rebalancing** per currency from Stripe payouts (batch tokenization), with alerts when a float runs low.
- [ ] **Local payer rails via partners later**: UPI (INR) and Pix (BRL) as `payerRails`. INR merchants need a licensed Indian partner, since there's no INR stablecoin on XRPL.
- [ ] **Docs**: settlement-xrpl.md §2 still describes the original 10,000 / 12,900 pool; update it to the deep pools and the per-currency seed.
