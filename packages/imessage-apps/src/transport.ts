// Low-level send/edit transport for the card presenter. Owner: Sahith (task SH-B4). Spec: docs/specs/imessage-apps.md §5
// The presenter (presenter.ts) holds all the logic (handles, queues, channel fallbacks) against this small interface,
// so it can be unit-tested with a fake. `createSpectrumTransport` is the real implementation over spectrum-ts.
//
//   iMessage: space.send(app(url, { live }))                 → card; the returned Message is the edit handle
//             space.send(edit(app(newUrl, { live }), original)) → same bubble, new content (resolves undefined)
//   WhatsApp: no app cards and no edits; sendCard degrades to the URL as plain text.

import type { Channel, Recipient } from "@rove/shared";
import { app, attachment, edit, UnsupportedError } from "spectrum-ts";
import type { Message, Space, SpectrumInstance } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";

/** Opaque per-transport handle to a sent card. The presenter only stores it and hands it back to `editCard`. */
export type CardHandle = unknown;

export interface CardTransport {
  /** True when the channel renders app cards and can edit them in place. */
  supportsCards(channel: Channel): boolean;
  /** Send `url` as an app card. `handle` must be passed back to `editCard` to change the same bubble. */
  sendCard(to: Recipient, url: string, live: boolean): Promise<{ messageId: string; handle: CardHandle }>;
  /** Replace the card behind `handle` with `url` in place. */
  editCard(to: Recipient, handle: CardHandle, url: string, live: boolean): Promise<void>;
  sendText(to: Recipient, body: string): Promise<{ messageId: string }>;
  /** PNG attachment, optionally followed by a caption. `messageId` is the image's id. */
  sendImage(to: Recipient, png: Uint8Array, name: string, caption?: string): Promise<{ messageId: string }>;
}

// ------------------------------------------------------------------ phone normalization

/** iMessage takes E.164 ("+6591234567") or an Apple ID email. Strips spaces, dashes, dots and parentheses. */
export function imessageAddress(phone: string): string {
  const raw = phone.trim();
  if (raw.includes("@")) return raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error(`invalid iMessage recipient: ${JSON.stringify(phone)}`);
  return `+${digits}`;
}

/** WhatsApp Business wants the number as digits only ("6591234567"). */
export function whatsappAddress(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) throw new Error(`invalid WhatsApp recipient: ${JSON.stringify(phone)}`);
  return digits;
}

/** Stable per-recipient key (`imessage:+6591234567`, `whatsapp:6591234567`) for caches and send queues. */
export function recipientKey(to: Recipient): string {
  return `${to.channel}:${to.channel === "whatsapp" ? whatsappAddress(to.phone) : imessageAddress(to.phone)}`;
}

// ------------------------------------------------------------------ Spectrum implementation

// `imessage(spectrum)` / `whatsappBusiness(spectrum)` are typed to resolve only when the instance's provider
// tuple contains that platform. The presenter accepts any instance, so narrow through these aliases; if the
// provider isn't configured at runtime, spectrum-ts throws on first use of that channel.
type IMessageSpectrum = SpectrumInstance<[ReturnType<typeof imessage.config>]>;
type WhatsAppSpectrum = SpectrumInstance<[ReturnType<typeof whatsappBusiness.config>]>;

/** What `sendCard` hands back for iMessage: the space plus the original outbound message (it carries the mini-app session). */
interface SpectrumCardHandle {
  space: Space;
  message: Message;
}

function isSpectrumCardHandle(h: unknown): h is SpectrumCardHandle {
  return typeof h === "object" && h !== null && "space" in h && "message" in h;
}

function requireMessage(m: Message | undefined, what: string, to: Recipient): Message {
  if (!m) throw new Error(`spectrum returned no message for ${what} to ${recipientKey(to)}`);
  return m;
}

export function createSpectrumTransport(spectrum: SpectrumInstance): CardTransport {
  const spaces = new Map<string, Promise<Space>>();

  async function createSpace(to: Recipient): Promise<Space> {
    if (to.channel === "imessage") {
      const im = imessage(spectrum as unknown as IMessageSpectrum);
      return im.space.create(await im.user(imessageAddress(to.phone)));
    }
    const wa = whatsappBusiness(spectrum as unknown as WhatsAppSpectrum);
    return wa.space.create(await wa.user(whatsappAddress(to.phone)));
  }

  /** One space per `${channel}:${phone}`. Caches the promise so concurrent first sends share it; evicts on failure. */
  function spaceFor(to: Recipient): Promise<Space> {
    const key = recipientKey(to);
    let p = spaces.get(key);
    if (!p) {
      p = createSpace(to);
      spaces.set(key, p);
      p.catch(() => {
        if (spaces.get(key) === p) spaces.delete(key);
      });
    }
    return p;
  }

  return {
    supportsCards(channel) {
      return channel === "imessage";
    },

    async sendCard(to, url, live) {
      const space = await spaceFor(to);
      if (to.channel !== "imessage") {
        // No app cards on WhatsApp: the link is the card. Not editable, so there's no useful handle.
        const m = requireMessage(await space.send(url), "card link", to);
        return { messageId: m.id, handle: undefined };
      }
      const message = requireMessage(await space.send(app(url, { live })), "app card", to);
      const handle: SpectrumCardHandle = { space, message };
      return { messageId: message.id, handle };
    },

    async editCard(to, handle, url, live) {
      if (to.channel !== "imessage") throw UnsupportedError.action("edit", to.channel, "app cards can't be edited on this channel");
      if (!isSpectrumCardHandle(handle)) throw new Error(`editCard: not a Spectrum card handle (${recipientKey(to)})`);
      // Always edit against the ORIGINAL message: Spectrum refreshes its miniAppCardSession on it. edit() resolves undefined.
      await handle.space.send(edit(app(url, { live }), handle.message));
    },

    async sendText(to, body) {
      const space = await spaceFor(to);
      const m = requireMessage(await space.send(body), "text", to);
      return { messageId: m.id };
    },

    async sendImage(to, png, name, caption) {
      const space = await spaceFor(to);
      const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
      const m = requireMessage(await space.send(attachment(bytes, { name, mimeType: "image/png" })), "image", to);
      if (caption) requireMessage(await space.send(caption), "image caption", to);
      return { messageId: m.id };
    },
  };
}
