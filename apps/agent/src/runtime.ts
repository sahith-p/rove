// Photon Spectrum runtime (SA-A1): providers per docs/specs/channels.md, the inbound message loop, sender →
// Recipient, Spectrum content → Inbound, and the per-sender serialization that keeps one conversation in order.

import { createSpectrumCardPresenter } from "@rove/imessage-apps";
import type { CardPresenter, Recipient } from "@rove/shared";
import { app, attachment, edit, Spectrum, type Message, type Space, type SpectrumInstance } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { whatsappBusiness, whatsappTemplate } from "spectrum-ts/providers/whatsapp-business";
import type { Agent } from "./app";
import { createBasicSpectrumPresenter } from "./cards";
import type { Config } from "./env";
import { handleInbound } from "./inbound";
import { createSpaceResolver, createSpectrumOutbox } from "./outbox";
import type { Inbound, Outbox, ReplyChannel } from "./ports";
import { toE164 } from "./tools/match";

/* eslint-disable @typescript-eslint/no-explicit-any -- Spectrum's provider-tuple generics aren't known statically here */
type AnySpectrum = SpectrumInstance<any>;
/** Sahith's presenter option (not re-exported from the package index). */
type WhatsAppTemplateSender = NonNullable<NonNullable<Parameters<typeof createSpectrumCardPresenter>[1]>["waTemplates"]>;

export interface SpectrumSetup {
  spectrum: AnySpectrum;
  providers: { imessage: boolean; whatsapp: boolean; terminal: boolean };
}

/** Spectrum with whichever providers are configured; null when none are. */
export async function createSpectrum(config: Config): Promise<SpectrumSetup | null> {
  const s = config.spectrum;
  const hasProject = Boolean(s.projectId && s.projectSecret);
  const wa = s.whatsapp;
  const providers = { imessage: hasProject, whatsapp: Boolean(wa.accessToken && wa.phoneNumberId), terminal: config.terminal };
  const list: any[] = [];
  if (providers.imessage) list.push(imessage.config());
  if (providers.whatsapp) {
    list.push(whatsappBusiness.config({ accessToken: wa.accessToken, phoneNumberId: wa.phoneNumberId, ...(wa.appSecret ? { appSecret: wa.appSecret } : {}) }));
  }
  if (providers.terminal) list.push(terminal.config());
  if (!list.length) return null;
  const spectrum = (await (hasProject
    ? Spectrum({ projectId: s.projectId, projectSecret: s.projectSecret, providers: list as any })
    : Spectrum({ providers: list as any }))) as AnySpectrum;
  return { spectrum, providers };
}

/** Outbox over Spectrum; cards through Sahith's presenter, or the basic fallback until SH-B4 lands. */
export function createRuntimeOutbox(setup: SpectrumSetup, config: Config, log: (...a: unknown[]) => void): Outbox {
  const opts = { spectrum: setup.spectrum, config, providers: setup.providers, log };
  const spaceFor = createSpaceResolver(opts);
  let presenter: CardPresenter;
  try {
    presenter = createSpectrumCardPresenter(setup.spectrum as any, setup.providers.whatsapp ? { waTemplates: whatsappInvoiceTemplate(spaceFor, config) } : {});
  } catch (err) {
    log("card presenter: using the basic fallback", err instanceof Error ? err.message : err);
    presenter = createBasicSpectrumPresenter({
      spaceFor: spaceFor as any,
      app: (url, o) => app(url, o),
      edit: (content, target) => edit(content as any, target as any),
      attachment: (png, o) => attachment(png, o),
    });
  }
  return createSpectrumOutbox({ ...opts, presenter, spaceFor });
}

/**
 * WhatsApp invoices to people outside the 24h window: the approved `rove_invoice` template (channels.md).
 * Body params {{1}} merchant name, {{2}} amount come from the card's fallbackText. Spectrum's v1 template content has
 * body params only, so the URL button suffix isn't sent; the pay link follows as text (delivered once they reply).
 */
function whatsappInvoiceTemplate(spaceFor: (to: Recipient) => Promise<Space>, config: Config): WhatsAppTemplateSender {
  return {
    async invoice(to, spec) {
      const space = await spaceFor(to);
      const m = /^(.*) sent you a (?:payment )?request for (\S+)/.exec(spec.fallbackText);
      const sent = await space.send(
        m
          ? whatsappTemplate({ name: config.spectrum.whatsappTemplate, languageCode: "en", bodyParams: [m[1]!, m[2]!] })
          : `${spec.fallbackText}\n${spec.url}`,
      );
      return { messageId: sent?.id ?? `unsent-${Date.now()}`, edited: false };
    },
  };
}

/** Sender of an inbound message → Recipient, or null if we can't message them back by phone. */
export function senderOf(message: Message, config: Config): Recipient | null {
  const id = message.sender?.id;
  switch (message.platform) {
    case "terminal":
      return { phone: config.terminalPhones[config.terminalAs], channel: "imessage" };
    case "imessage": {
      if (!id || id.includes("@")) return null; // email handles have no phone
      const phone = toE164(id);
      return phone ? { phone, channel: "imessage" } : null;
    }
    case "whatsapp_business": {
      const digits = (id ?? "").replace(/\D/g, "");
      return digits ? { phone: `+${digits}`, channel: "whatsapp" } : null;
    }
    default:
      return null;
  }
}

/** Spectrum content → the agent's Inbound shape. */
export async function toInbound(message: Message): Promise<Inbound> {
  const c = message.content as any;
  switch (c.type) {
    case "text":
      return { type: "text", text: String(c.text ?? "") };
    case "markdown":
      return { type: "text", text: String(c.markdown ?? "") };
    case "voice":
      return { type: "voice", audio: await c.read(), mimeType: String(c.mimeType ?? "audio/mp4") };
    case "attachment":
      if (String(c.mimeType ?? "").startsWith("audio/")) return { type: "voice", audio: await c.read(), mimeType: String(c.mimeType) };
      return { type: "other", kind: `attachment:${c.mimeType}` };
    case "reaction":
      return { type: "reaction", emoji: String(c.emoji ?? ""), targetMessageId: String(c.target?.id ?? "") };
    case "poll_option":
      return { type: "poll_option", title: String(c.option?.title ?? c.title ?? ""), pollTitle: String(c.poll?.title ?? ""), selected: c.selected !== false };
    case "contact": {
      const name: string | null = c.name?.formatted ?? ([c.name?.first, c.name?.last].filter(Boolean).join(" ") || null);
      const phones = ((c.phones ?? []) as { value: string; type?: string }[])
        .sort((a, b) => Number(b.type === "mobile") - Number(a.type === "mobile"))
        .map((p) => toE164(p.value))
        .filter((p): p is string => Boolean(p));
      return { type: "contact", name, phones, note: c.note ?? null };
    }
    default:
      return { type: "other", kind: String(c.type) };
  }
}

function replyChannel(space: Space): ReplyChannel {
  return {
    async text(body) {
      const sent = await space.send(body);
      return { messageId: sent?.id ?? `unsent-${Date.now()}` };
    },
    responding: (fn) => space.responding(fn),
  };
}

/** The inbound loop. Each message is handled off the loop, serialized per sender so a conversation stays in order. */
export async function runMessageLoop(setup: SpectrumSetup, agent: Agent): Promise<void> {
  const { deps } = agent;
  const chains = new Map<string, Promise<void>>();
  for await (const [space, message] of setup.spectrum.messages) {
    if (message.direction === "outbound") continue;
    const from = senderOf(message, deps.config);
    if (!from) {
      deps.log("skipping message from unknown sender", message.platform, message.sender?.id);
      continue;
    }
    const prev = chains.get(from.phone) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        if (!(await deps.store.claim(`spectrum:${message.id}`))) return;
        const inbound = await toInbound(message);
        deps.log("←", from.channel, from.phone, inbound.type === "text" ? JSON.stringify(inbound.text) : inbound.type);
        await handleInbound(agent, from, inbound, replyChannel(space));
      })
      .catch((err) => deps.log("message handling failed", from.phone, err));
    chains.set(from.phone, next);
    void next.finally(() => {
      if (chains.get(from.phone) === next) chains.delete(from.phone);
    });
  }
}
