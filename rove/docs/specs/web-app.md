# Spec · The minimal web app

Owner: **Sahith** (pages) · APIs: **Nithya** (+ Saran for `/api/actions`) · Code: `apps/web/app/**` · Tasks: SH-A*, SH-B2, SH-B5, SH-C*

**Principle:** there is no dashboard. Each page does one job, opens from a message, and must work both in Safari and **inside Messages** (Spectrum iMessage App card, ~375px wide). No nav bar, no login screen: merchant pages authenticate with the `t` token in their URL; customer pages need none.

## Pages

| Page | Job | Key states |
|---|---|---|
| `/pay/[code]` | Customer pays an invoice / one-time QR | loading · open (merchant name + ✓ verified, line items, total, Apple Pay button, "Pay with BNB Chain wallet") · paying · **paid ✓** (+ "View on XRPL") · expired · already paid · cancelled |
| `/m/[merchantId]` | Fixed QR: pick menu items or type an amount, then pay | menu grid with +/- · free amount · total · same pay buttons |
| `/r/[paymentId]` | Receipt (customer) · sale view (merchant, `?view=merchant&t=`) | settled · refunded |
| `/setup?t=` | Shop setup mini-app: name, category, menu editor (add/edit/remove, price) | saved toast; the agent edits the setup card after `shop.updated` |
| `/bank?t=` | Add bank: PayNow UEN / PayNow mobile / bank account + holder name | saved: shows resolved name + last 4 · error · expired link (15 min) |
| `/w/[withdrawalId]?t=` | Withdrawal status stepper + **step-up confirm** button | requested (needs step-up) · approved · on XRPL ✓ · sent to bank ✓ · completed (FAST ref) · failed/returned |
| `/confirm/[actionId]?t=` | Confirm/cancel a pending refund, withdrawal or setting | proposed · executing · done · expired |
| `/shop?t=` | Minimal "my shop": balance (available / held, "Ledger ✓ matches XRPL"), last 10 payments, open invoices, contacts, menu (read-only; edit via setup) | — |
| `/` | One line + "Text us to open a shop" | — |

## Shared rules

- Mobile-first, one column, big amount, a status stepper component reused by `/pay`, `/w`, `/confirm`.
- Read `t` server-side (`verifyToken<MerchantSessionPayload>`, Node runtime), pass it to client fetches as `x-rove-session`.
- Poll status every 1–2s on `/pay` (after paying), `/w`, `/confirm`. No websockets.
- `generateMetadata` + `next/og` images per state (SH-B3) so static card previews show "S$12.50 · Paid ✓".
- Every amount comes from the API; never trust query params for money.
- Label simulated parts: "Bank payout simulated (demo)" on `/w` and payout states.
- Design: light, fliptexts-inspired (docs/specs/design.md), but only after G3.

## Apple Pay inside Messages

Apple Pay in the Spectrum iMessage App web view is **unverified**. First-hour experiment (SH-B4): open `/pay/<code>` from a card and check whether the Express Checkout Element shows Apple Pay. If not, the page shows an "Open in Safari to pay with Apple Pay" button (`target=_blank`), and the card still updates to "Paid ✓".
