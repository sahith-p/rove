# 07 · Demo

Owner: **Sahith**. Two minutes max on YouTube; the same script live for the top-3 finals.

## Setup (by 16:15)

- Phone M (merchant, Rove thread open, Spectrum iMessage app installed), phone C (customer, Apple Wallet card, Privy demo login), optional phone W (WhatsApp).
- Printed fixed-QR sticker on a sign: "Ah Seng Chicken Rice".
- Laptop: XRPL explorer, BscScan testnet, `/shop` for ahseng, logs in a corner.
- Mirror phones M and C (QuickTime over cable) or a document camera.
- `USE_TERMINAL_PROVIDER=0`, `USE_MOCK_CARDS=0`, `USE_MOCK_SETTLEMENT=0`. Don't redeploy anything.

## Script

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:10 | "Small shops run on chat. Rove makes the chat the cash register: invoices, QR codes, payouts, all by text." | phone M |
| 0:10–0:30 | Onboarding replay (pre-recorded, sped up): "hi" → name → poll → setup card → confetti + sticker | phone M |
| 0:30–0:55 | Live: "invoice Maya 2 chicken rice and a barley" → phone C gets the card → **Apple Pay inside Messages** → "Paid ✓" + receipt; phone M sale card | M + C |
| 0:55–1:10 | "One XRPL transaction turned dollars into Singapore-dollar stablecoin in Ah Seng's account." Explorer | laptop |
| 1:10–1:22 | "QR for 6.50" → phone C scans → pays USDT with a **BNB Chain** wallet → same flow | M + C |
| 1:22–1:45 | "withdraw everything" → step-up → card: *On XRPL → Sent to bank → In your bank · FAST-881245*. "Bank payout is simulated; everything before it is live on testnet." | phone M |
| 1:45–1:55 | Voice note: "how much did I make today?" → spoken answer | phone M (audio) |
| 1:55–2:00 | "Rove. Your shop, in a text thread." | — |

## Backups

| If this breaks | Do this |
|---|---|
| Apple Pay not shown inside Messages | "Open in Safari" button → Apple Pay there |
| Apple Pay sheet fails entirely | card form with 4242 |
| Card doesn't arrive | open the same page from the link in Safari; the sale still shows on `/shop` |
| XRPL testnet slow | pre-recorded tx from rehearsal |
| BNB beat flaky | skip it (12 s) |
| Voice slow | read the text reply that arrives with it |
| Everything | the 16:30 recording |

## Submission (16:45)

Public repo + README (architecture, "what's real vs simulated" from docs/00), YouTube link, live link, tracks: **Most Technically Impressive**, Ripple, YZi, ElevenLabs.
