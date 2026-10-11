# Spec · XRPL settlement engine

Owner: **Nithya** · Code: `packages/xrpl`, `apps/worker` · Contract: `SettlementEngine` (`packages/shared/src/settlement.ts`) · Tasks: NI-A1…A5, NI-C2

## 1. Accounts and assets (testnet)

| Account | Role | Created by |
|---|---|---|
| `USD_ISSUER` | issues the **RLUSD stand-in** (currency code `RLUSD`) | seed |
| `SGD_ISSUER` | issues the **XSGD stand-in** (currency code `XSGD`) | seed |
| `TREASURY` | Rove's USD float; sends every settlement | seed |
| `LP` | liquidity for the RLUSD/XSGD AMM pool | seed |
| `REDEMPTION` | stands in for StraitsX's XSGD redemption address (bank withdrawals) | seed |
| `CRED_ISSUER` | issues `ROVE_VERIFIED_MERCHANT` Credentials | seed |
| merchant accounts | one custodial account per merchant; holds XSGD; seed encrypted in DB (demo custody) | `createMerchantAccount()` |

- Endpoint `wss://s.altnet.rippletest.net:51233`; explorer `https://testnet.xrpl.org/transactions/<hash>`.
- **Currency codes longer than 3 characters must be 40-hex**: `Buffer.from(code).toString("hex").toUpperCase().padEnd(40, "0")` (`src/currency.ts`).
- If Ripple offers a real testnet RLUSD issuer/faucet (ask at their table), swap `USD_ISSUER`; keep the code issuer-agnostic.
- Say it in the demo: "test tokens we issue with the same codes; mainnet uses real RLUSD and StraitsX XSGD."

## 2. Seed (`pnpm seed`, NI-A2), idempotent

1. `client.fundWallet()` per platform account (skip if `.env.seed` has it and `account_info` works).
2. **`AccountSet SetFlag: 8` (asfDefaultRipple) on both issuers before any trust line.** Without it tokens can't move through the AMM.
3. `TrustSet` from TREASURY, LP, REDEMPTION to both issuers.
4. Mint: issuer → LP (10,000 RLUSD; 12,900 XSGD); issuer → TREASURY (5,000 RLUSD).
5. `AMMCreate` from LP: 10,000 RLUSD / 12,900 XSGD, `TradingFee: 30`. xrpl.js `autofill` sets the special AMMCreate fee.
6. Create demo merchant `ahseng` via `createMerchantAccount()`.
7. Write `.env.seed`; print explorer links.

## 3. Quote (NI-A3)

```ts
const r = await client.request({
  command: "ripple_path_find",
  source_account: TREASURY,
  destination_account: merchantAddress,
  destination_amount: { currency: XSGD, issuer: SGD_ISSUER, value: "12.50" },
  source_currencies: [{ currency: RLUSD, issuer: USD_ISSUER }],
});
const best = r.result.alternatives[0];           // source_amount + paths_computed
```
`usd` = source amount rounded **up** to cents; `sendMaxUsd` = usd × 1.01 rounded up; `rate` = local / usd; expires in 60s. Fallback: constant-product math from `amm_info`.

## 4. Settle (NI-A3), gate G1

```ts
const tx: Payment = {
  TransactionType: "Payment",
  Account: TREASURY,
  Destination: merchantAddress,
  Amount:  { currency: XSGD,  issuer: SGD_ISSUER, value: local.amount },  // exactly what the merchant gets
  SendMax: { currency: RLUSD, issuer: USD_ISSUER, value: sendMaxUsd },   // most we'll spend
  InvoiceID: sha256hex(paymentId).toUpperCase(),                         // 64 hex: tx ↔ payment
  ...(paths.length ? { Paths: paths } : {}),
};
const res = await client.submitAndWait(tx, { wallet: treasury, autofill: true });
```
- Success = `meta.TransactionResult === "tesSUCCESS"`; record `meta.delivered_amount` (must equal `local.amount`). No `tfPartialPayment`.
- Then: payment `settled`, invoice `paid`, ledger `payment_credit` (ref = paymentId), event `payment.settled`.
- Errors: `tecPATH_PARTIAL` / `tecPATH_DRY` → re-quote once, retry, then fail + Stripe auto-refund; `tecNO_LINE` → fix merchant trust line; `tefPAST_SEQ` → retry.
- **Serialize treasury submissions** (one in flight) to avoid sequence collisions.

## 5. Merchant accounts (NI-A4)

1. `Wallet.generate()`; encrypt seed (AES-256-GCM, `WALLET_ENCRYPTION_KEY`); store.
2. TREASURY sends 3 XRP (reserves for the account, 2 trust lines, the Credential + fees; check `server_info`).
3. Merchant `TrustSet` → XSGD and RLUSD issuers.
4. `CredentialCreate` (CRED_ISSUER → Subject merchant, `CredentialType` hex `ROVE_VERIFIED_MERCHANT`); `CredentialAccept` from the merchant.
5. `isVerifiedMerchant`: `ledger_entry { credential: { subject, issuer, credential_type } }` exists and has `lsfAccepted`.

**Ask the Ripple table whether Credentials are enabled on testnet.** If not: skip 4, use a DB flag; the badge still works. If xrpl.js types lack Credential txs, cast through `unknown`.

## 6. Refund (NI-A5)

Merchant → TREASURY cross-currency payment (Amount = RLUSD equivalent, SendMax = local XSGD), signed with the decrypted merchant seed. The customer gets their money back from Stripe (payments-stripe.md §6).

## 7. Withdrawals, the on-chain half (NI-A5)

- **To bank:** `sweepToRedemption` = merchant → REDEMPTION, same-currency XSGD payment, `InvoiceID = sha256(withdrawalId)`.
- **To own wallet:** `sendToWallet` = merchant → the merchant's XRPL address, XSGD; first check the destination has an XSGD trust line (`account_lines`), else return a clear error the agent can explain.
- `balance(merchantAddress)` = XSGD line balance (`account_lines`), used by the reconciler.
Full pipeline: docs/specs/withdrawals.md.

## 8. Gate G1

`pnpm --filter @rove/xrpl settle:demo`: quote S$12.50 → settle to `ahseng` → print `delivered_amount` + explorer URL. Pass = exactly 12.5 XSGD (normalize with `money()`).
