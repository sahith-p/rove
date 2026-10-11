# Spec · Channels: iMessage (Photon Spectrum)

Owner: **Saran** (runtime) · **Sahith** (presenter) · Tasks: SA-A1, SH-B4

One Spectrum app, iMessage only. WhatsApp was dropped: no Meta app, no `rove_invoice` template, no WhatsApp fallbacks. The terminal provider stays for dev and evals.

```ts
const spectrum = await Spectrum({
  providers: [
    imessage.config(),                         // Photon cloud lines (SPECTRUM_PROJECT_ID/SECRET)
    ...(process.env.USE_TERMINAL_PROVIDER === "1" ? [terminal.config()] : []),
  ],
});
```

## What we use on iMessage

| Feature | iMessage (Photon cloud) |
|---|---|
| Start a chat with a new number | ✓ (50 new conversations / line / day) |
| App cards (`app()`) + live UI | ✓ (Spectrum iMessage App, installed once) |
| Edit in place (`edit()`) | ✓ |
| Tapback confirm (👍) | ✓ (a YES reply also works) |
| Polls | ✓ (`poll()`); a typed 1–4 is accepted too |
| Screen effects (confetti) | ✓ (`effect()`) |
| Contact cards in/out | ✓ |
| Voice notes in/out | ✓ |
| Images (QR PNGs) | ✓ |
| Typing indicator | ✓ (`space.responding`) |

People who aren't on iMessage pay with a QR code or a pay link someone forwards them; the agent doesn't text them.

## Demo plan

iMessage is the whole stage: cards, tapbacks and confetti.
