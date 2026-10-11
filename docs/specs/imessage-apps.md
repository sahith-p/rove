# Spec · iMessage App cards (Photon App API)

Owner: **Sahith** · Code: `packages/imessage-apps` (builders, presenter, QR images), pages in `apps/web/app/**` · Contract: `cards.ts` · Tasks: SH-B1…B6

## 1. What Photon gives us (Spectrum docs, stable)

- `space.send(app(url, { live }))` sends a URL as a **native iMessage App card**. It opens inside the **Spectrum iMessage App** launcher (Apple-approved). Recipients install it once, from inside Messages, the first time they tap a card.
- `live: true` asks Messages to render the live web UI instead of the static URL preview. It's a hint that needs a supported platform + the extension installed.
- **Edit in place:** keep the message returned by the first send and call `space.send(edit(app(newUrl, { live }), original))`. Same bubble, new content. Cloud package `@spectrum-ts/imessage` only. `edit()` resolves `undefined`; keep reusing the original message (Spectrum refreshes its `miniAppCardSession`).
- `customizedMiniApp({ appName, extensionBundleId, teamId, url, layout })` gives a branded bubble with caption/subcaption/image, but needs **our own iMessage extension** (Apple Team ID + bundle id). Out of scope unless the experiment in SH-B4 shows the static layout renders without the extension installed.
- Also used: `poll()`, `effect(content, imessage.effect.message.confetti)`, `contact()` / `nativeContactCard()`, `attachment()` (QR PNGs), `voice()`, tapbacks (`Emoji.like`), typing via `space.responding`.
- Quotas: 5,000 messages/server/day; 50 new conversations per line per day.

## 2. Cards (both sides of the payment)

| Kind | Recipient | When sent | Edited when | Page |
|---|---|---|---|---|
| setup | merchant | onboarding / "edit my shop" | `shop.updated` → "Ah Seng Chicken Rice · 4 items ✓" | `/setup?t=` |
| bank | merchant | onboarding / "add my bank" | `bank_account.added` → "DBS ••••1234 ✓" | `/bank?t=` |
| shop | merchant | "open my shop" | — | `/shop?t=` |
| menu | anyone | "show menu" | `shop.updated` | `/m/<id>` |
| invoice | **customer** | `create_invoice` | `payment.settled` → "Paid ✓" | `/pay/<code>` |
| receipt | **customer** | `payment.settled` | `refund.completed` → "Refunded" | `/r/<paymentId>` |
| sale | merchant | `payment.settled` | `refund.completed` | `/r/<paymentId>?view=merchant&t=` |
| withdrawal | merchant | `propose_withdrawal` (step-up) / approved | every `withdrawal.updated` | `/w/<id>?t=` |
| confirm | merchant | any `propose_*` | executing → done / expired | `/confirm/<actionId>?t=` |

## 3. Builders (SH-B1), pure

`createCardBuilders({ baseUrl })` → URLs from `links(baseUrl)` + `&v=<state>` (a new `v` whenever the visible state changes so Messages refetches the preview). Merchant cards embed a **scoped session token** created by the caller (`signToken<MerchantSessionPayload>`; scopes and TTLs in `tokens.ts`). `fallbackText` is a full sentence; `updateText` is set only for states worth a new WhatsApp message (withdrawal completed/failed, invoice paid). Unit-test every kind.

## 4. Pages

The pages are the minimal web app (docs/specs/web-app.md); cards just open them. Each page sets `generateMetadata` + a `next/og` image per state (SH-B3), so the static preview reads "S$12.50 · Paid ✓" even if live rendering doesn't work.

## 5. Presenter (SH-B4)

```ts
export function createSpectrumCardPresenter(spectrum: SpectrumInstance, opts: { waTemplates?: WhatsAppTemplateSender }): CardPresenter {
  const handles = new Map<string, { space: Space; message: Message }>();      // spec.key → original send
  const spaceFor = async (to: Recipient) => to.channel === "imessage"
    ? imessage(spectrum).space.create(await imessage(spectrum).user(to.phone))
    : whatsappBusiness(spectrum).space.create(await whatsappBusiness(spectrum).user(to.phone.replace("+", "")));
  return {
    async send(to, spec) {
      if (to.channel === "whatsapp" && spec.kind === "invoice" && opts.waTemplates) return opts.waTemplates.invoice(to, spec); // 24h rule
      const space = await spaceFor(to);
      const message = to.channel === "imessage"
        ? await space.send(app(spec.url, { live: spec.live }))
        : await space.send(`${spec.fallbackText}\n${spec.url}`);
      handles.set(spec.key, { space, message });
      return { messageId: message.id, edited: false };
    },
    async update(to, spec) {
      const h = handles.get(spec.key);
      if (to.channel === "whatsapp") return spec.updateText ? this.text(to, `${spec.updateText}\n${spec.url}`).then((m) => ({ ...m, edited: false })) : null;
      if (!h) return this.send(to, spec);                                       // lost on restart → new bubble
      await h.space.send(edit(app(spec.url, { live: spec.live }), h.message));
      return { messageId: h.message.id, edited: true };
    },
    async text(to, body) { const m = await (await spaceFor(to)).send(body); return { messageId: m.id }; },
    async image(to, png, name, caption) { /* attachment(Buffer.from(png), { name, mimeType: "image/png" }) + caption */ },
  };
}
```
- Check exact type names against the installed `spectrum-ts`.
- Serialize sends per recipient (promise chain per phone) so card order matches event order. Cache spaces per phone.
- **First-hour experiments (log answers in `tasks/integration.md`):** does `live: true` render our page live? Does Apple Pay appear inside the card's web view? Does a tapback on an app card arrive as a `reaction` whose `target.id` is the card's message id? Does `customizedMiniApp` render a static layout without our extension?

## 6. QR images (SH-B6)

`qrPng(url)` (via `qrcode`, error correction M, 1024px) and `stickerPng({ name, url, verified })`: a printable sticker (shop name, QR, "✓ Verified on XRPL", "Scan to pay · Apple Pay"). Rendered server-side (e.g. `@napi-rs/canvas` or an SVG → PNG step); the agent sends them as attachments.

## 7. Acceptance (G2)

`pnpm --filter @rove/imessage-apps card-smoke`: the setup card reaches the merchant iPhone → opens `/setup` inside Messages → `update()` with a new `v` changes the same bubble.
