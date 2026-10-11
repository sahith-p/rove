# Spec · BNB Chain wallet pay-in, XRPL settlement

Status: **Core, and the move**: the only rail with no card fees (payments-stripe.md §8). Second pay button on `/pay` and `/m`, built after Apple Pay works (gate G3b, 15:00); the pitch leads with it. Covers YZi's BNB setup steps.

**NI-C6 (backend) is built**: deposit addresses in `/api/checkout`, the watcher in `apps/worker/src/bnb`, the test token, and `apps/worker/scripts/bsc-setup.ts`. Waiting on humans: tBNB for the deployer from a faucet (§7), then three script commands. SH-A4 (Privy button) is Sahith's; §5 is what it must send.

Owners: **Nithya** (deposit addresses in `/api/checkout`, watcher in `apps/worker/src/bnb`) + **Sahith** (Privy wallet button on the pay pages). Tasks: NI-C6, SH-A4.

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

## 1. Test stablecoin: what we use and why

Checked 2026-10-11:

| What | Finding | Source |
|---|---|---|
| Official faucet | The token dropdown offers **only tBNB** (0.3 tBNB per 24 h). The faucet needs 0.002 BNB on BSC **mainnet** in the wallet. Its FAQ says pegged BEP-20 test tokens (USDT, BUSD, …) exist, but the faucet doesn't hand them out any more. | https://www.bnbchain.org/en/testnet-faucet |
| Faucet docs | "Major pegged tokens like BUSD, USDT" are mentioned, but no contract addresses are listed. The Discord faucet is gone. Third-party faucets: QuickNode, Chainstack. | https://docs.bnbchain.org/bnb-smart-chain/developers/faucet |
| Pegged test USDT `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` | Read on-chain with `name()`, `symbol()`, `decimals()`, `totalSupply()`: "USDT Token", **USDT, 18 decimals**, supply 100,000,000. Same owner as the pegged USDC `0x6454…8930`. 37 transfers in the last 50k blocks and none from a faucet, so it can't be had on demand. | BSC testnet RPC (`bsc-testnet-rpc.publicnode.com`) |
| `0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684` | "Tether USD", USDT, 18 decimals (PancakeSwap testnet's). No faucet. | same |

**Decision: Rove's own `tUSDT`** (`apps/worker/src/bnb/TestUSDT.sol`). It's a minimal ERC-20 with **18 decimals like BSC's USDT** and an owner-only `mint`. The deployer key mints to the Privy demo wallet, so we never depend on a faucet drip. The code doesn't care which token: `BSC_TOKEN_ADDRESS` + `BSC_TOKEN_DECIMALS` select it, and the worker checks the decimals on-chain at boot. The pegged USDT above works too if someone holds some.

- Build: `bsc-setup.ts compile` runs solc-js 0.8.26 through `npx` with optimizer 200 and evm `paris` (nothing is added to package.json). It checks the output against the bytecode committed in `tusdt.ts`; `compile --write` refreshes that bytecode. `tusdt.test.ts` fails if the `.sol` changes without a recompile.
- Dry run on BSC testnet, no funds needed (`bsc-setup.ts simulate`): deploy costs 476,001 gas × 0.1 gwei ≈ **0.00005 tBNB**. `name`/`symbol`/`decimals` read back as "Rove Test USDT"/`tUSDT`/18. Only the deployer can mint. A customer `transfer` returns true and emits `Transfer(customer → deposit, 9.69)` under `eth_simulateV1`.
- Chain facts: chainId 97, about **0.45 s blocks** (measured over 1000 blocks), so 3 confirmations take about 1.4 s.
- **RPC:** the bnbchain.org `data-seed-prebsc-*` endpoints refuse `eth_getLogs` ("limit exceeded", even for one block). The watcher needs that call, so use **`https://bsc-testnet-rpc.publicnode.com`** (ranges up to 50k blocks). It's the worker's default. The `.env.example` default line predates this finding, so a data-seed `BSC_RPC_URL` is swapped for publicnode automatically, with a warning in the log.

## 2. Deposit addresses (`/api/checkout`, method `bnb`)

Files: `apps/web/app/api/checkout/bnb.ts` and `apps/web/app/api/_lib/bsc.ts`.

- One address per payment: `m/44'/60'/0'/0/<n>`, with `n = db.nextDepositIndex()`. The sequence starts at 1; index 0 is kept for a collector. No memo is needed.
- **The web holds no keys.** It derives addresses from `BSC_DEPOSIT_XPUB`, the account xpub of `m/44'/60'/0'/0`, using viem's `HDKey` plus secp256k1 point decompression. It refuses an xprv, or a key at the wrong depth.
- The worker derives the same addresses, with their keys, from `BSC_DEPOSIT_MNEMONIC` (`bnb/keys.ts`). Tests prove that xpub-derived = mnemonic-derived (Anvil vectors, random mnemonics, indexes up to 2³¹−1). At boot the worker logs an error if the two env vars don't match.
- Charge: `charge = quote.usd` (cents, rounded up), always USD; `payCurrency` is ignored because USDT is a dollar. `insertPayment({ method: "bnb", charge, bnbDepositAddress, … })`.
- Response: `CheckoutRes` with `bnb: { chainId: 97, depositAddress, token, decimals, amount: charge.amount }`.
- **Reuse** follows the card lane's rules. A repeat call for the same invoice, or the same fixed-QR basket + phone, gets the same payment and the **same address** while its quote has at least 5 s left. A reloaded page therefore never shows a payer who already paid a second address. `Payment` doesn't expose `bnb_deposit_address`, so a bnb payment id ends in `_bsc<index>`. Reuse re-derives the address from that index and confirms it with `getPaymentByDepositAddress`, which also covers a rotated xpub.
- Errors: an invoice already authorized/settled → 409 `invoice_paid`. Lane env missing → **503 `bnb_not_configured`**, with nothing written and no index used. A malformed env (an xprv, a bad token address) → 500, logged.

## 3. Watcher (worker)

Files: `apps/worker/src/bnb/{index,watcher,source,config,keys}.ts`.

`startBnbWatcher(deps)` starts from `jobs.ts`.

**Boot checks:**
- It refuses to watch when the chainId isn't 97, or when the token's on-chain `decimals()` differs from `BSC_TOKEN_DECIMALS` (a 6-vs-18 mix-up would be off by 10¹²).
- It checks the xpub against the mnemonic.
- `BSC_TOKEN_ADDRESS` unset → the watcher stays off.

**Polling:** every `BSC_POLL_MS` (3 s) it runs `eth_getLogs` for the token's `Transfer` events over (cursor, head], in `BSC_LOG_RANGE` chunks.
- The cursor lives in memory. On boot it starts `BSC_RESCAN_BLOCKS` (10,000 ≈ 75 min) back, so deposits made while the worker was down are still found; `claim()` makes the rescan safe.
- Logs with fewer than **3 confirmations** (block > head − 2) wait, and the cursor stays below them. "Deposit seen, waiting for confirmations n/3" is logged once.
- An RPC or DB error holds the cursor before the failed block. RPC errors are logged once per outage, not every poll.

For each confirmed log:

| Case | What happens |
|---|---|
| `to` isn't a deposit address | ignored, nothing written |
| value ≥ charge in token base units (bigint, `toUnits(charge, decimals)`) | CAS `created → authorized` `{ method: "bnb", payinTxHash }` → `scheduleSettle` (settle.ts; the settle poller is the fallback) → XRPL settle `from: "USD"` |
| value < charge | **UNDERPAID**, logged as an error, payment left `created`. A top-up to the same address doesn't add up. |
| paid (block time) after quote expiry but within **1 h** | accepted, logged as a late deposit. Rove absorbs the drift; settle re-quotes. |
| more than 1 h after quote expiry | not authorized, logged; refund by hand |
| payment already authorized/settled | **EXTRA deposit**, logged; refund by hand |
| invoice already paid by another payment (unique index) | not authorized, logged; refund by hand |

- Then `claim("bsc:" + txHash + ":" + logIndex)`. If the claim returns false, the log was already handled before a restart, so the watcher does nothing and logs nothing.
- The CAS runs **before** the claim on purpose. The CAS is idempotent on its own (only `created` moves), and claiming last means a crash between the two can never strand a confirmed deposit.
- Run one watcher process. Two would both stay correct, but one of them might log a false "extra deposit".
- Refunds on this lane stay manual (§6). `settle.ts` already logs "token refund pending review" when a bnb settlement fails.

## 4. Env vars

| Var | Web (Vercel) | Worker | Notes |
|---|---|---|---|
| `BSC_DEPOSIT_XPUB` | ✔ | optional (checked against the mnemonic) | public; account xpub `m/44'/60'/0'/0` |
| `BSC_TOKEN_ADDRESS` | ✔ | ✔ | unset = lane off (checkout 503, watcher off) |
| `BSC_TOKEN_DECIMALS` | ✔ | ✔ | 18 for tUSDT and for the pegged USDT |
| `BSC_DEPOSIT_MNEMONIC` | **never** | ✔ | secret; for sweeping / manual refunds (`depositKeyring(m).indexOf(addr)`) |
| `BSC_RPC_URL` | – | ✔ | default `https://bsc-testnet-rpc.publicnode.com` |
| `BSC_POLL_MS`, `BSC_RESCAN_BLOCKS`, `BSC_LOG_RANGE` | – | optional | 3000 / 10000 / 5000 |
| `BSC_DEPLOYER_KEY` | **never** | **never** | `bsc-setup.ts` only (deploy, mint, send-gas, pay) |

`bsc-setup.ts init` writes all of these to `.env.bsc` at the repo root. The file is gitignored by `.env*` and has mode 600. Copy the lines you need into `.env`, or into Railway/Vercel.

## 5. What the pay page sends (SH-A4, Privy / MetaMask)

After `POST /api/checkout { target, method: "bnb", payerPhone? }`:

```ts
const { bnb } = res;                                   // { chainId: 97, depositAddress, token, decimals, amount }
// make sure the wallet is on BSC testnet first: wallet.switchChain(97)
const data = encodeFunctionData({                      // viem
  abi: erc20Abi,
  functionName: "transfer",
  args: [bnb.depositAddress, parseUnits(bnb.amount, bnb.decimals)],   // "9.69", 18 → 9690000000000000000n
});
await sendTransaction({ to: bnb.token, data, chainId: 97 });           // Privy useSendTransaction / eth_sendTransaction
```

Then poll `GET /api/payments/:paymentId` until `authorized` (about 2–5 s after the transfer), then `settled`. Never round `amount`. Never send less: an underpayment isn't authorized. Gas is paid in tBNB, so the demo wallet needs about 0.01 tBNB.

## 6. Refunds

The XRPL side is the normal refund (`refunds.ts`). Sending tUSDT back from the deposit address is manual for now: the key is `depositKeyring(BSC_DEPOSIT_MNEMONIC).account(index)`, and the index is in the payment id (`_bsc<index>`). The deposit address also needs a little tBNB for gas. There is no automatic sweep yet.

## 7. Setup and demo steps

```bash
pnpm --filter worker exec tsx scripts/bsc-setup.ts init        # once: keys → .env.bsc; prints PUBLIC addresses + next steps
# HUMAN: get ~0.05 tBNB for the deployer address it prints:
#   https://www.bnbchain.org/en/testnet-faucet (needs 0.002 BNB on BSC mainnet in the wallet; you can claim to your own
#   wallet and forward) · https://faucet.quicknode.com/binance-smart-chain/bnb-testnet · https://faucet.chainstack.com/bnb-testnet-faucet
pnpm --filter worker exec tsx scripts/bsc-setup.ts deploy      # tUSDT → BSC_TOKEN_ADDRESS in .env.bsc
pnpm --filter worker exec tsx scripts/bsc-setup.ts mint <privy-wallet> 1000
pnpm --filter worker exec tsx scripts/bsc-setup.ts send-gas <privy-wallet> 0.01
pnpm --filter worker exec tsx scripts/bsc-setup.ts live-demo   # real transfer → real watcher → authorized → settled (PGlite + mock XRPL)
```

Then copy the `.env.bsc` lines into `.env` (worker) and the three public ones into Vercel. Run `pnpm dev`, open a pay link, pick "Pay with a BNB Chain wallet", and send. The worker log shows `deposit seen … 1/3`, then `deposit confirmed: payment authorized` with the BSC tx hash, then `settling` → `settled` with the XRPL explorer link.

Checks that need no funds:
- `bsc-setup.ts simulate` dry-runs the token.
- `bsc-setup.ts replay <txHash> [token]` runs the real RPC watcher over a real testnet transfer. For example, `replay 0x1df182da10ca262d8985902a29f3a60090272d9331cf2ce50936ab7a95b49efe 0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` authorizes and settles a payment for that 0.05 USDT transfer. A later transfer to the same address shows up as an EXTRA deposit.

## 8. Tests

- `apps/web/app/api/_lib/bsc.test.ts`: derivation, xpub = mnemonic, xprv/depth rejection.
- `apps/web/app/api/checkout/bnb.test.ts`: response, payment row and `bnbDepositAddress`, reuse, per-method reuse, expired quote, rotated xpub, 409, 503.
- `apps/worker/src/bnb/keys.test.ts`.
- `apps/worker/src/bnb/watcher.test.ts`: 3 confirmations; exact/over/under in 18-decimal units; claim dedupe across restarts; unknown address; extra deposit; late/too late; duplicate invoice; outage; boot rescan.
- `apps/worker/src/bnb/e2e.test.ts`: `createTestDeps`; deposit → authorized → settle poller → settled + ledger credit + `payment.settled`; `startBnbWatcher` boot checks.
- `apps/worker/src/bnb/tusdt.test.ts`.

## Contract (already in packages/shared)

- `CheckoutReq.method: "card" | "bnb" | "ausd"`
- `CheckoutRes.bnb?: { chainId: 97, depositAddress, token, decimals, amount }`
- `PaymentMethod` includes `"bnb"`; `payments.bnb_deposit_address`, `payments.payin_tx_hash`.
- Privy demo account: one fixed customer login (a Privy test account if your plan has it, else any email) whose embedded wallet is pre-funded with tBNB + tUSDT (§7).
- Nice to have (not needed): `Payment.bnbDepositAddress` (optional field + one line in `@rove/db` map.ts). With it, reuse could read the address directly instead of the `_bsc<index>` id suffix.
