# Spec · Checkout API + Stripe

Owner: **Nithya** · Code: `apps/web/app/api/{checkout,stripe,invoices,shops,payments,me,_lib}/**` · Contracts: `CheckoutReq/Res`, `InvoicePublicRes`, `ShopPublicRes`, `PaymentStatusRes`, `MeRes`, `UpdateShopReq`, `UpdateMenuReq` · Tasks: NI-B2…B5, NI-C5

## 1. `POST /api/checkout` (NI-B2)

1. `CheckoutReq.parse`.
2. Resolve target:
   - `invoice`: `getInvoiceByCode(code)`; must be `open` and unexpired; lines + total from the invoice; payer = invoice recipient.
   - `fixed_qr`: merchant must be `live`; total = Σ menu items × qty (prices from the DB) or `amount`; 0 < total ≤ S$500.
3. `quote = await settlement.quote({ local: total })` (mock until G1).
4. Pick the **payer currency** (§1a): `payCurrency` from the request, else the payer's phone country, else USD. `charge` = `quote.usd` if USD, `total` if SGD.
5. Insert `payments` (`status=created`, `source`, `invoice_id`, `lines`, quote fields, `charge`, payer).
6. `method=card`:
   ```ts
   const pi = await stripe.paymentIntents.create(
     { amount: Number(toMinor(charge)), currency: charge.currency.toLowerCase(), automatic_payment_methods: { enabled: true },
       metadata: { paymentId, merchantId } },
     { idempotencyKey: paymentId },
   );
   ```
   → `{ charge, stripe: { clientSecret } }`.
7. `method=bnb`: next HD deposit address → `{ charge: quote.usd, bnb: { chainId: 97, depositAddress, token, decimals, amount: quote.usd.amount } }` (docs/specs/bnb-lane.md). USDT is a dollar, so a BNB payer is always a USD payer.

### 1a. Charge in the payer's currency (no card FX)

The point of Rove is that stablecoins replace card and bank conversion rates. The card leg must therefore never cross a currency. A US card charged in SGD pays its issuer's foreign transaction fee, typically about 3%. Stripe also adds its own surcharge on top of 2.9% + 30¢: 1% for currency conversion on a US account, or 1.5% for an international card on an SG account. So Apple Pay stays, but it is always charged in the payer's own currency:

| Payer | Charged | Card leg | Settlement (worker) |
|---|---|---|---|
| Foreign, e.g. a US tourist (demo: Maya, +1) | `quote.usd` in **USD** on Rove's US Stripe account | domestic: no FX markup, no foreign transaction fee | treasury RLUSD → AMM → exact XSGD (`settle`, `from: "USD"`) |
| Local (+65) | `total` in **SGD** | domestic for an SG card | treasury XSGD → XSGD, no swap (`settle`, `from: "SGD"`) |
| Stablecoin wallet (BNB lane) | `quote.usd` in USDT | no card at all | same as USD |

- Dollars in and Singapore dollars out still means the currency changes once. It happens as a **stablecoin-to-stablecoin swap at the market rate** (pool fee 0.3% in the seed, already inside `quote.usd`), not at a card network's markup. The pay page shows it plainly: "US$9.72 · S$12.50 at 1.2860 · no card FX fees".
- **Choosing the currency before the Apple Pay sheet opens** (the sheet shows a fixed amount): texted flows use the payer's phone country (`+1` → USD, `+65` → SGD). QR scans send `payCurrency` from the browser locale, and the page offers a USD/SGD toggle. Don't use IP geolocation: a tourist in Singapore has a Singapore IP.
- Other payer countries fall back to USD until they get a rail of their own (for example UPI for Indian payers, later).
- Demo: Stripe test mode on a US account, so USD payers are fully domestic. An SGD charge on a US account would pay Stripe's 1% conversion; that is acceptable in test mode, and production adds an SG Stripe entity.
- Production: Rove keeps a float in each payer currency on XRPL and rebalances it in batches from Stripe payouts at 1:1 (USD → RLUSD/USDC is tokenization, not conversion). This is the same model as the BNB lane.
- Not chosen: Apple Pay → crypto onramp (Stripe or Coinbase) → wallet → merchant. It needs KYC for every buyer and is US/EU only. Apple Pay on Stripe's onramp needs sales approval, and Coinbase's Apple Pay guest checkout was scheduled to end on 30 June 2026. A tourist at a hawker stall won't do KYC.

## 2. Webhook `POST /api/stripe/webhook` (NI-B3)

```ts
export const runtime = "nodejs";
const raw = await req.text();                                  // raw body, never re-stringified JSON
const event = stripe.webhooks.constructEvent(raw, req.headers.get("stripe-signature")!, STRIPE_WEBHOOK_SECRET);
if (!(await db.claim(`stripe:${event.id}`))) return ok();
if (event.type === "payment_intent.succeeded") {
  // Apple Pay vs card: retrieve with expand latest_charge → payment_method_details.card.wallet?.type === "apple_pay"
  if (await db.transitionPayment(paymentId, ["created"], "authorized", { method })) nudgeWorkerSettle(paymentId);
}
```
The worker also polls `authorized` payments every 3s, so a lost nudge costs only seconds. Local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## 3. Apple Pay (do it before 12:30)

- Stripe Dashboard → Settings → **Payment method domains** → add the Vercel domain. Apple Pay shows only on registered HTTPS domains, in Safari / iOS, with a card in Wallet.
- In test mode, a real Wallet card shows the real sheet and nothing is charged. **Verify on the demo phone in the first hour**, both in Safari and inside the iMessage card (docs/specs/web-app.md).
- Fallback: the card form with 4242 4242 4242 4242.

## 4. Read routes (NI-B4)

`GET /api/invoices/:code`, `GET /api/shops/:merchantId` (verified via `isVerifiedMerchant`, cached 60s), `GET /api/payments/:id`, all `Cache-Control: no-store`.

## 5. Merchant routes (NI-B5)

`GET /api/me`, `PUT /api/me/shop`, `PUT /api/me/menu`: verify `x-rove-session` (`verifyToken<MerchantSessionPayload>`, scope check), then emit `shop.updated` to the agent. Bank accounts + withdrawals: docs/specs/withdrawals.md.

## 6. Refunds (worker, NI-C5)

`stripe.refunds.create({ payment_intent, amount }, { idempotencyKey: "refund:" + actionId })` + XRPL merchant → treasury + ledger `refund_debit`.

## 7. Failure policy

| Failure | Action |
|---|---|
| Quote expired before paying | page re-calls checkout (new quote); old PI cancelled |
| Settle fails after Stripe succeeded | 2 retries with fresh quote → `failed` + automatic Stripe refund + `payment.failed` |
| Invoice paid twice (race) | unique index `payments_one_per_invoice` rejects the second authorization → auto-refund it |
| Duplicate webhook | `claim()` |

## 8. Fees, and how we present them to judges

**Who pays what.** Card rails cost about 3% somewhere no matter what. Stripe takes 2.9% + 30¢ out of every card charge before it reaches Rove, so a tourist's saved ~3% foreign transaction fee mostly moves to whoever pays Stripe. On hawker-sized tickets the fixed 30¢ dominates: about 6% of a US$9.72 sale and about 10% of a S$5.50 chicken rice.

| Rail | Payer pays | Card fee | Who absorbs it |
|---|---|---|---|
| **Stablecoin wallet (BNB lane, Privy): the move** | market rate + 0.3% pool fee + cents of gas | **none** | — |
| Apple Pay / card in the payer's own currency | market rate + 0.3% pool fee | 2.9% + 30¢ | demo: Rove (test mode). Production: the merchant, like any card terminal, on tourist sales they'd otherwise lose |

- **The stablecoin wallet lane is the move.** It is the only rail where nobody pays card fees, so it's where Rove is cheaper for everyone. Apple Pay is the on-ramp for tourists who don't hold stablecoins yet.
- **The payer always pays the market rate.** We never add a fee in place of their bank's foreign transaction fee. It would erase the payer's savings, and a 3% fee only covers Stripe on tickets above about US$300. As a US merchant of record it would also count as a card surcharge, which card-network rules cap and don't allow on debit cards.
- The fee is not paid from an "agent wallet". The agent never moves money (CLAUDE.md); Stripe nets its fee out of the charge, and plain code records the cost.
- **Later: top up once.** A tourist loads e.g. US$50 into a Rove balance with Apple Pay (one 30¢ fee, ~3.5% total) and pays many stalls from it by text or QR. This is the tourist's balance held by Rove (custodial, like merchant balances), not the agent's wallet. In production it is stored value and brings extra regulation.

**Saying it to judges (keep it exact):**
- "Pay in your own currency; the merchant gets theirs. Tourists pay the market rate, not a 3% foreign transaction fee or a 3–12% 'pay in your currency' (DCC) markup, and stalls that can't take foreign cards now can."
- "With a stablecoin wallet there are no card fees at all: dollars in, one market-rate stablecoin swap on XRPL, Singapore dollars out."
- If asked "who pays Stripe?": "In the demo we absorb it. In production the merchant pays a card-like fee on tourist sales they'd otherwise lose, and the stablecoin lane has no card fee."
- Don't claim "everyone pays less": a travel card with no foreign transaction fee roughly ties with Rove on the card rail.
