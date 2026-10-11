// pnpm seed: idempotent XRPL testnet setup. Owner: Nithya (task NI-A2). Spec: docs/specs/settlement-xrpl.md §2
// Steps:
//  1. Fund wallets from the testnet faucet: USD issuer, SGD issuer, treasury, liquidity provider (LP),
//     redemption account (stands in for StraitsX), credential issuer.
//  2. AccountSet asfDefaultRipple on both issuers (BEFORE any trust lines; needed for the AMM).
//  3. TrustSet from treasury, LP and redemption to the issuers (RLUSD stand-in, XSGD stand-in).
//  4. Mint: issuer → LP and issuer → treasury.
//  5. AMMCreate RLUSD/XSGD from the LP at ~1.29 SGD per USD (e.g. 10,000 / 12,900), TradingFee 30.
//  6. Create the demo merchants via createMerchantAccount() (trust lines + Credential).
//  7. Write addresses/seeds to .env.seed and print explorer links.

console.log("seed: not implemented yet (NI-A2)");
