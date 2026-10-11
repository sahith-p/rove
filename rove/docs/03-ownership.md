# 03 · Ownership

Every path has exactly one owner. Agents write only inside their owner's paths (`CLAUDE.md`). `.github/CODEOWNERS` enforces it.

| Person | Area | Paths |
|---|---|---|
| **Sahith** | Minimal web app (every page) | `apps/web/app/{pay,m,r,setup,bank,shop,w,confirm}/**`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/components/**`, `apps/web/lib/ui/**` |
| | iMessage App API: card builders, presenter (send / edit in place, WhatsApp fallbacks + template), QR images | `packages/imessage-apps/**` |
| | Privy wallet button (BNB pay-in UI) | `apps/web/components/privy/**` |
| | Demo + pitch | `docs/07-demo.md`, video, printed sticker, devices |
| **Nithya** | Database | `packages/db/**` |
| | XRPL settlement engine + seed | `packages/xrpl/**` |
| | Payments + merchant APIs (Stripe, checkout, invoices, shops, me, bank accounts, withdrawals) | `apps/web/app/api/{checkout,stripe,invoices,shops,payments,me,withdrawals,_lib}/**` |
| | Worker: settle, ledger, refunds, **withdrawal pipeline**, payout partner, BNB watcher, reconciler | `apps/worker/**` |
| **Saran** | Agent runtime (Photon: iMessage + WhatsApp + terminal), persona routing, internal HTTP | `apps/agent/src/{index,runtime,server,events,personas}.ts` |
| | Claude loop, merchant + customer tools, prompts, evals | `apps/agent/src/agent/**`, `apps/agent/src/tools/**`, `apps/agent/evals/**` |
| | Onboarding conversation, pending actions, contacts-in, reminders, voice | `apps/agent/src/{onboarding,actions,contacts,reminders,voice}.ts` |
| | Confirm route | `apps/web/app/api/actions/**` |
| **All three** | Contracts | `packages/shared/**`, `docs/02-contracts.md` |
| **Each person** | Their task list | `tasks/<name>.md` |
| **Shared, append-only** | Requests + gate log | `tasks/integration.md` |

## Seams

| Seam | Contract | Left | Right | Gate |
|---|---|---|---|---|
| Pay pages ↔ checkout API | `InvoicePublicRes`, `ShopPublicRes`, `CheckoutReq/Res`, `PaymentStatusRes` | Sahith | Nithya | G3 |
| Setup / bank / shop pages ↔ merchant API | `MeRes`, `UpdateShopReq`, `UpdateMenuReq`, `AddBankAccountReq` | Sahith | Nithya | G2b, G4 |
| Agent ↔ cards | `CardBuilders`, `CardPresenter` | Saran (calls) | Sahith (implements) | G2 |
| Worker/web → agent | `EventEnvelope` | Nithya | Saran | G3 |
| Agent → worker | internal withdrawals, refunds, merchants | Saran | Nithya | G2b, G4 |
| Confirm buttons ↔ agent | `ConfirmActionReq/Res` | Sahith (pages) | Saran (route + executor) | G4 |
| Agent tools ↔ DB | `@rove/db` helpers (menu, contacts, invoices, ledger) | Saran | Nithya | G2b |

## Decision rights

- Inside your paths: decide alone, document in your spec.
- Contracts: all three (docs/02).
- Demo script + 4:00 cuts: Sahith proposes, majority decides.
- Real money or real credentials: nobody. Testnet + test mode only.
