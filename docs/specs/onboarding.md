# Spec · Merchant onboarding over chat (with iMessage App cards)

Owners: **Saran** (conversation, `apps/agent/src/onboarding.ts`) · **Sahith** (setup + bank pages and cards, sticker) · **Nithya** (`/internal/merchants`, `/api/me/*`) · Tasks: SA-A4, SH-B2, SH-C1, NI-C1, NI-B5

Anyone who texts Rove and isn't a merchant gets the customer agent. "start a shop" / "I want to sell" / a first "hi" with no invoices → onboarding. State lives in the `onboarding` table (per phone), so a restart doesn't lose progress.

## iMessage flow (about 60 seconds)

| # | Rove sends | Merchant does | Under the hood |
|---|---|---|---|
| 1 | "Hi! I'm Rove. I'll set up your shop in a minute." + **`nativeContactCard()`** ("save me so you can find me") | taps to save | `onboarding.step = name` |
| 2 | "What's your shop called?" | "Ah Seng Chicken Rice" | slug `ahseng` proposed (unique) |
| 3 | **`poll("What do you sell?", "Hawker food", "Drinks", "Groceries", "Something else")`** | votes | `poll_option` content → category |
| 4 | **Setup card** `app(/setup?t=…, live)` + "Add your menu here, or just text items like 'chicken rice 5.50'" | edits the menu in the card **or** texts items | `PUT /api/me/menu` → `shop.updated` → agent **edits the setup card**: "4 items ✓" |
| 5 | "Creating your shop…" (typing indicator) | — | `POST /internal/merchants` → custodial XRPL account, XSGD trust line, Credential issued + accepted (~8–15 s) |
| 6 | **`effect("You're live! 🎉", confetti)`** + **fixed QR sticker PNG** | — | `merchant.live` |
| 7 | **Bank card** `app(/bank?t=…)` + "Add your bank so you can withdraw anytime. Bank details stay out of this chat." | fills the form (or "later") | `bank_account.added` → "DBS ••••1234 ✓" |
| 8 | "Try it: 'invoice +65… 2 chicken rice' or 'QR for 6.50'. Share a contact card to save a regular." | — | `onboarding.step = done` |

## WhatsApp flow

Same steps; the poll becomes "Reply 1–4", cards become links, the effect becomes "🎉", and setup-card edits become a short confirmation message.

## Rules

- Steps are plain code; Claude is used only to parse free text (shop name, menu lines like "chicken rice 5.50, barley 1.50", "later") into structured data with a strict tool schema.
- Any step can be skipped or redone by text ("change name to …", "add my bank later").
- Merchant pages get **scoped** tokens: setup (24h), bank (15 min).

## Demo

Optional live beat: onboard a second phone ("Uncle's Kopi") in under a minute. The main demo uses pre-seeded `ahseng`, onboarded during rehearsal.
