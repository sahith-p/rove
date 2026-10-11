# Spec · BNB Chain wallet pay-in, XRPL settlement

Status: **Core, and the move**: the only rail with no card fees (payments-stripe.md §8). Second pay button on `/pay` and `/m`, built after Apple Pay works (gate G3b, 15:00); the pitch leads with it. Covers YZi's BNB setup steps.

Owners: **Nithya** (deposit addresses in `/api/checkout`, watcher in `apps/worker/src/bnb`) + **Sahith** (Privy wallet button on the pay pages). Estimate: ~1.5 h backend + ~45 min UI. Tasks: NI-C6, SH-A4.

## The idea: wallet on BNB, settlement on XRPL

```
Customer wallet (BNB Chain)          Rove                                  Merchant
  Privy embedded wallet  ──USDT──►  BSC deposit address   (pay-in)
  or MetaMask                        │ watcher confirms
                                     ▼
                                   XRPL treasury RLUSD ──path payment──►  XSGD → bank (SGD)
```

- **No bridge per payment.** Rove holds a float on each chain. Pay-ins land in Rove's BSC wallet; the merchant is paid from Rove's RLUSD float on XRPL immediately. Floats are rebalanced in batches offline (exchange or bridge), which is how real cross-border payment companies run. Say this when judges ask.
- Pitch line: "Pay from whatever chain you hold. Merchants always settle on one rail."
- Tracks: YZi gets BNB Chain + stablecoin merchant checkout; Ripple keeps XRPL as the settlement layer.

## Build

1. **Test stablecoin on BSC testnet (chainId 97):** use test USDT from the BNB testnet faucet if it offers one; otherwise deploy a 20-line OpenZeppelin ERC-20 (`tUSDT`, 18 decimals) from Remix and mint to the demo customer wallet.
2. **Customer wallet:**
   - **Privy** embedded EVM wallet (email login) configured for BSC testnet. Privy supports all EVM chains, so this is where Privy fits. Pre-fund the demo customer's wallet with tUSDT + a little tBNB for gas.
   - Or any injected wallet (MetaMask) via viem.
3. **Pay-in address:** one Rove deposit address per payment, derived from an HD wallet (`m/44'/60'/0'/0/<n>`), so no memo is needed. Store it on the payment.
4. **Watcher (worker):** viem `watchContractEvent` for `Transfer(to = depositAddress)` on the tUSDT contract over the BSC testnet RPC. After 3 confirmations and `value ≥ quote.usd` (scaled to token decimals), mark the payment `authorized` and run the normal XRPL settle step.
5. **Pay pages:** second button "Pay with a BNB Chain wallet" → `POST /api/checkout { method: "bnb" }` → show amount + deposit address, or one-tap send through Privy/MetaMask (`transfer(depositAddress, amount)`).
6. Refunds on this lane: the XRPL side is the normal refund; send test USDT back from the deposit address to the payer (stretch; otherwise "refund pending review").

## Contract (already in packages/shared)

- `CheckoutReq.method: "card" | "bnb"`
- `CheckoutRes.bnb?: { chainId: 97, depositAddress, token, decimals, amount }`
- `PaymentMethod` includes `"bnb"`; `payments.bnb_deposit_address`, `payments.payin_tx_hash`.
- Privy demo account: one fixed customer login (Privy test account if your plan has it, else any email) whose embedded wallet is pre-funded with tBNB + test USDT.
