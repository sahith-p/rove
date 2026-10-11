# Spec · Checkout API + Stripe

Owner: **Nithya** · Code: `apps/web/app/api/{checkout,stripe,invoices,shops,payments,me,_lib}/**` · Contracts: `CheckoutReq/Res`, `InvoicePublicRes`, `ShopPublicRes`, `PaymentStatusRes`, `MeRes`, `UpdateShopReq`, `UpdateMenuReq` · Tasks: NI-B2…B5, NI-C5

## 1. `POST /api/checkout` (NI-B2)

1. `CheckoutReq.parse`.
2. Resolve target:
   - `invoice`: `getInvoiceByCode(code)`; must be `open` and unexpired; lines + total from the invoice; payer = invoice recipient.
   - `fixed_qr`: merchant must be `live`; total = Σ menu items × qty (prices from the DB) or `amount`; 0 < total ≤ S$500.
3. `quote = await settlement.quote({ local: total })` (mock until G1).
4. Insert `payments` (`status=created`, `source`, `invoice_id`, `lines`, quote fields, payer).
5. `method=card`:
   ```ts
   const pi = await stripe.paymentIntents.create(
     { amount: Number(toMinor(total)), currency: "sgd", automatic_payment_methods: { enabled: true },
       metadata: { paymentId, merchantId } },
     { idempotencyKey: paymentId },
   );
   ```
   → `{ stripe: { clientSecret } }`.
6. `method=bnb`: next HD deposit address → `{ bnb: { chainId: 97, depositAddress, token, decimals, amount: quote.usd.amount } }` (docs/specs/bnb-lane.md).

The charge is in **SGD**; the customer's card issuer converts from their home currency, so customers can be from anywhere.

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
