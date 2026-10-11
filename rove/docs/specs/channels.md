# Spec · Channels: iMessage and WhatsApp (Photon Spectrum)

Owner: **Saran** (runtime, Meta setup, template submission) · **Sahith** (presenter behavior per channel) · Tasks: SA-A1, SA-C4, SH-B4

One Spectrum app, two providers. Messages from both merge into `app.messages`; `message.platform` tells them apart.

```ts
const spectrum = await Spectrum({
  providers: [
    imessage.config(),                         // Photon cloud lines (SPECTRUM_PROJECT_ID/SECRET)
    whatsappBusiness.config(),                 // direct mode from SPECTRUM_WHATSAPP_BUSINESS_* env, or Photon cloud mode
    ...(process.env.USE_TERMINAL_PROVIDER === "1" ? [terminal.config()] : []),
  ],
});
```

## Capability matrix

| Feature | iMessage (Photon cloud) | WhatsApp Business |
|---|---|---|
| Start a chat with a new number | ✓ (50 new conversations / line / day) | **only with an approved template**, or after they message us (24-hour window) |
| App cards (`app()`) + live UI | ✓ (Spectrum iMessage App, installed once) | link only |
| Edit in place (`edit()`) | ✓ | ✗ → send a new message only for important changes (`updateText`) |
| Tapback confirm (👍) | ✓ | ✗ → reply YES |
| Polls | ✓ (`poll()`) | ✗ → numbered options ("Reply 1, 2 or 3") |
| Screen effects (confetti) | ✓ (`effect()`) | ✗ → emoji |
| Contact cards in/out | ✓ | ✓ (contacts content) |
| Voice notes in/out | ✓ | ✓ (audio) |
| Images (QR PNGs) | ✓ | ✓ |
| Typing indicator | ✓ (`space.responding`) | ✓ where supported |

## WhatsApp setup (Saran, before G0)

- Meta for Developers app + WhatsApp Business account + test phone number → `SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN`, `…_PHONE_NUMBER_ID`, `…_APP_SECRET` (or use a Photon cloud WhatsApp line if your plan includes one).
- **Submit the invoice template at 11:30**, as approval isn't instant:
  - name `rove_invoice`, category Utility, language en
  - body: `{{1}} sent you a payment request for {{2}}. Tap below to pay securely.`
  - URL button: `https://<PUBLIC_BASE_URL host>/pay/{{1}}` (dynamic suffix = invoice code)
- Template sends use Photon's WhatsApp kit `template("rove_invoice","en").body(text(merchantName), text("S$12.50")).urlButton(0, text(code))` (Sahith's presenter, SH-B4). If the template isn't approved by demo time: invoices go to iMessage numbers only, and WhatsApp users pay via QR.

## Demo plan

iMessage is the main stage (cards, tapbacks, confetti). Show WhatsApp in one beat: a second merchant or customer on WhatsApp texting the same agent ("balance?" / receiving a template invoice if approved).
