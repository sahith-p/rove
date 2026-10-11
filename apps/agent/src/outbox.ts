// Outbox implementations.
//  - Console (USE_MOCK_CARDS=1, offline dev, evals): logs every send and optionally records it. Message ids are
//    unique ("mock-msg-N") across cards and texts, so evals can 👍 a confirm card by id.
//  - Spectrum: cards through the CardPresenter (Sahith's, or the basic fallback); polls, effects, voice notes and
//    contact cards channel-native, with WhatsApp fallbacks per docs/specs/channels.md.

import type { CardPresenter, CardSpec, Channel, Recipient } from "@rove/shared";
import { attachment, poll, text as textContent, voice as voiceContent, type Message, type Space, type SpectrumInstance } from "spectrum-ts";
import { effect as imessageEffect, imessage, nativeContactCard } from "spectrum-ts/providers/imessage";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";
import type { Config } from "./env";
import type { Outbox, ScreenEffect } from "./ports";

export interface RecordedSend {
  kind: "card" | "card-edit" | "text" | "image" | "poll" | "effect" | "voice" | "contact";
  to: string;
  body: string;
  messageId: string;
  card?: CardSpec;
}

export function createConsoleOutbox(opts: { log: (line: string) => void; record?: RecordedSend[] }): Outbox {
  let n = 0;
  const id = () => `mock-msg-${++n}`;
  const known = new Map<string, string>(); // `${phone}|${key}` → first message id
  const out = (kind: RecordedSend["kind"], to: Recipient, body: string, card?: CardSpec) => {
    const messageId = id();
    opts.record?.push({ kind, to: to.phone, body, messageId, ...(card ? { card } : {}) });
    opts.log(`[${kind}] → ${to.channel}:${to.phone} ${body} (${messageId})`);
    return messageId;
  };
  const cards: CardPresenter = {
    async send(to, spec) {
      const messageId = out("card", to, `${spec.kind} ${spec.key} ${spec.url} | ${spec.fallbackText}`, spec);
      known.set(`${to.phone}|${spec.key}`, messageId);
      return { messageId, edited: false };
    },
    async update(to, spec) {
      const original = known.get(`${to.phone}|${spec.key}`);
      if (!original) return this.send(to, spec);
      out("card-edit", to, `${spec.kind} ${spec.key} ${spec.url}${spec.updateText ? ` | ${spec.updateText}` : ""}`, spec);
      return { messageId: original, edited: true };
    },
    async text(to, body) {
      return { messageId: out("text", to, body) };
    },
    async image(to, png, name, caption) {
      return { messageId: out("image", to, `${name} (${png.byteLength} bytes)${caption ? ` "${caption}"` : ""}`) };
    },
  };
  return {
    cards,
    text: cards.text,
    image: cards.image,
    async poll(to, title, options) {
      return { messageId: out("poll", to, `${title} [${options.join(" | ")}]`) };
    },
    async effect(to, body, fx) {
      return { messageId: out("effect", to, `${body} {${fx}}`) };
    },
    async voice(to, audio, o) {
      return { messageId: out("voice", to, `${o.name} ${o.mimeType} (${audio.byteLength} bytes)`) };
    },
    async contactCard(to) {
      out("contact", to, "Rove contact card");
    },
    async resolveChannel() {
      return "imessage";
    },
  };
}

// ------------------------------------------------------------------ Spectrum

/* eslint-disable @typescript-eslint/no-explicit-any -- provider callables are typed per provider tuple; we only know them at runtime */
type AnySpectrum = SpectrumInstance<any>;

export interface SpectrumOutboxOptions {
  spectrum: AnySpectrum;
  config: Config;
  /** Which providers were configured at boot. */
  providers: { imessage: boolean; whatsapp: boolean };
  log: (...args: unknown[]) => void;
}

/** Space per recipient, cached. Shared by the outbox and the basic card presenter. */
export function createSpaceResolver(o: SpectrumOutboxOptions) {
  const spaces = new Map<string, Promise<Space>>();
  return async function spaceFor(to: Recipient): Promise<Space> {
    const key = `${to.channel}|${to.phone}`;
    let space = spaces.get(key);
    if (!space) {
      space = (async () => {
        if (to.channel === "whatsapp") {
          if (!o.providers.whatsapp) throw new Error("WhatsApp is not configured");
          return (whatsappBusiness as any)(o.spectrum).space.create(to.phone.replace(/\D/g, "")) as Promise<Space>;
        }
        if (!o.providers.imessage) throw new Error("iMessage is not configured");
        const im = (imessage as any)(o.spectrum);
        return im.space.create(await im.user(to.phone)) as Promise<Space>;
      })();
      spaces.set(key, space);
      space.catch(() => spaces.delete(key));
    }
    return space;
  };
}

const IMESSAGE_EFFECT: Record<ScreenEffect, string> = {
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  balloons: "com.apple.messages.effect.CKBalloonEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
};

export function createSpectrumOutbox(o: SpectrumOutboxOptions & { presenter: CardPresenter; spaceFor?: (to: Recipient) => Promise<Space> }): Outbox {
  const spaceFor = o.spaceFor ?? createSpaceResolver(o);
  const idOf = (m: Message | Message[] | undefined) => (Array.isArray(m) ? m[0]?.id : m?.id) ?? `unsent-${Date.now()}`;
  const send = async (to: Recipient, content: any) => idOf(await (await spaceFor(to)).send(content));
  const channels = new Map<string, Channel>();

  return {
    cards: o.presenter,
    async text(to, body) {
      return { messageId: await send(to, body) };
    },
    async image(to, png, name, caption) {
      const messageId = await send(to, attachment(Buffer.from(png), { name, mimeType: "image/png" }));
      if (caption) await send(to, caption);
      return { messageId };
    },
    async poll(to, title, options) {
      if (to.channel === "whatsapp") {
        const numbered = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
        const choices = options.map((_, i) => String(i + 1));
        const last = choices.pop();
        return { messageId: await send(to, `${title}\n${numbered}\nReply ${choices.join(", ")}${choices.length ? " or " : ""}${last}.`) };
      }
      return { messageId: await send(to, poll(title, options)) };
    },
    async effect(to, body, fx) {
      if (to.channel === "whatsapp") return { messageId: await send(to, `${body} 🎉`) };
      return { messageId: await send(to, imessageEffect(textContent(body), IMESSAGE_EFFECT[fx] as any)) };
    },
    async voice(to, audio, v) {
      return { messageId: await send(to, voiceContent(audio, { name: v.name, mimeType: v.mimeType, duration: v.duration })) };
    },
    async contactCard(to) {
      if (to.channel !== "imessage") return;
      await send(to, nativeContactCard()).catch((err) => o.log("contact card failed", err));
    },
    async resolveChannel(phone) {
      const cached = channels.get(phone);
      if (cached) return cached;
      let channel: Channel = "imessage";
      if (o.providers.imessage) {
        try {
          const user = await (imessage as any)(o.spectrum).user(phone);
          if (user?.service !== "iMessage" && o.providers.whatsapp) channel = "whatsapp";
        } catch (err) {
          o.log("resolveChannel failed", phone, err);
          if (o.providers.whatsapp) channel = "whatsapp";
        }
      } else if (o.providers.whatsapp) {
        channel = "whatsapp";
      }
      channels.set(phone, channel);
      return channel;
    },
  };
}
