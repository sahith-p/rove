# 00 · Overview

**One line:** a payments agent you text. Merchants set up a shop, send invoices, make QR codes and withdraw to their bank, all by messaging. Customers pay with Apple Pay or card, or with USDT from a BNB Chain wallet, from a link or QR. Everything settles on XRPL in the merchant's local stablecoin (XSGD).

**Pitch hook:** "Your shop, your invoices, your bank payouts, all in a text thread."

**Messaging first, web minimal.** iMessage and WhatsApp (through Photon Spectrum) are the interface. The web app is a handful of single-purpose pages that open from a message, inside Messages on iPhone as iMessage App cards. There is no dashboard.

## What people do

**Merchant (texts the Rove number):**
| Says | Rove does |
|---|---|
| "hi" (first time) | onboarding in the chat: shop name, category poll, **setup card** (an iMessage app) to edit the menu, shop goes live with a confetti effect and the **fixed QR sticker** |
| "add chicken rice 5.50, barley 1.50" | updates the menu |
| shares a contact card / "add Maya +65…" | saves a customer contact |
| "invoice Maya 2 chicken rice and a barley" | builds the invoice from the menu (S$12.50) and **texts Maya** a pay card |
| "QR for 6.50" | sends a **one-time QR** image (single use, dies when paid) |
| "send my QR sticker" | sends the **fixed QR** (customer enters an amount or picks from the menu) |
| (a customer pays) | sale card: "S$12.50 from Maya · settled" |
| "balance?" / "how much today?" | answers from the ledger |
| "add my bank" | sends the **secure bank card**: a form; bank numbers never go in chat |
| "withdraw everything" | proposes a withdrawal → 👍 (or YES on WhatsApp) → live **withdrawal card**: *On XRPL → Sent to bank → In your bank* |
| "refund Maya" | proposes a refund → 👍 → refunded |
| voice note: "how much did I make this week?" | answers by voice (ElevenLabs) |

**Customer:** gets "Ah Seng Chicken Rice sent you a request for S$12.50" with a pay card → taps → pays with **Apple Pay** (or card, or USDT from a **BNB Chain** wallet via Privy) → gets a receipt in the same thread. They can also text Rove: "what do I owe?", "my receipts". Scanning a QR leads to the same pay page.

## Money path

```
Customer: Apple Pay / card (Stripe)        or   USDT from a BNB Chain wallet (Privy)
              │                                         │
              └──────── Rove treasury (RLUSD float on XRPL) ──────────┘
                                    │  one cross-currency XRPL Payment through the RLUSD/XSGD AMM
                                    ▼
                    Merchant's custodial XRPL account: balance in XSGD  ← ledger in Postgres tracks holds
                                    │  "withdraw" (human-confirmed)
              ┌─────────────────────┴─────────────────────┐
     to bank: XSGD → redemption (StraitsX)         to own wallet: XSGD → merchant's XRPL address
              → SGD over PayNow/FAST (simulated)          (real on testnet)
```

**Each chain does what it's best at:** card networks and BNB Chain are where customers' money is. XRPL holds the merchant's local-currency balance and does FX, settlement and merchant verification (XRPL Credentials). The bank is where merchants spend.

## What's real vs simulated in the demo

| Piece | Demo | Production |
|---|---|---|
| Messaging agent, iMessage App cards, voice | **Real** (Photon, Claude, ElevenLabs) | Same; dedicated Photon line |
| WhatsApp | **Real** for chats the user starts; business-started invoices need an approved Meta template | Same |
| Apple Pay / card | Real Apple Pay sheet, **Stripe test mode** | Stripe live |
| BNB Chain pay-in | **Real, BSC testnet** (test USDT, Privy demo wallet) | USDT/USDC on BNB Chain |
| XRPL settlement, AMM, Credentials, custodial balances | **Real, XRPL testnet** | Mainnet, regulated custody |
| RLUSD / XSGD | Test tokens **we issue** with the same codes | Real RLUSD (Ripple), XSGD (StraitsX; live on XRPL since May 2025) |
| Withdraw to own XRPL wallet | **Real** | Same |
| Withdraw to bank | Real XRPL redemption tx + **simulated StraitsX payout** (labeled) | StraitsX payouts API (business account; access through their sales team) |

**Currency:** the demo is Singapore (SGD/XSGD), because a local stablecoin and a payout partner exist there. India/UPI would need a licensed Indian partner (no INR stablecoin on XRPL that we know of); it's a slide, not a build. The code takes currency as data.

## Tracks

- **Ripple:** custodial merchant balances in XSGD, RLUSD → XSGD path payments through an AMM, trust lines, Credentials, delivered_amount accounting, redemption + self-custody withdrawals.
- **YZi:** stablecoin merchant checkout + BNB Chain pay-in (their BNB testnet setup steps). *Confirm at the YZi table.*
- **ElevenLabs:** voice notes in and out.
- **Most Technically Impressive:** one agent for both sides of a payment, iMessage App cards edited in place, an agent that can't move money without a human, double-entry withdrawals reconciled against the ledger.

## Glossary

| Term | Meaning |
|---|---|
| Invoice | A payment request sent to a person by message (`/pay/<code>`) |
| One-time QR | An invoice shown as a QR; single use |
| Fixed QR | The shop's permanent QR (`/m/<shop>`); payer enters an amount or picks menu items |
| Settle | Treasury → merchant XRPL payment delivering XSGD |
| Balance | XSGD on the merchant's custodial XRPL account = ledger available + held |
| Withdrawal | Merchant XSGD → bank (via redemption + payout partner) or → their own XRPL wallet |
| Card | An iMessage App bubble (Photon `app()`), editable in place (`edit()`) |
| Pending action | Refund / withdrawal / setting the agent proposed; runs only after a human confirms |
| Gate | Integration checkpoint with a pass/fail test (docs/04) |
