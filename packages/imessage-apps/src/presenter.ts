// CardPresenter over Photon Spectrum, for merchants and customers. Owner: Sahith (task SH-B4). Spec: docs/specs/imessage-apps.md §5
// The agent runtime (Saran) creates the Spectrum instance and passes it in; this module only sends/edits.
//   iMessage: app(url, {live}) to send, edit(app(newUrl, {live}), original) to update in place.
//   WhatsApp: fallbackText + url as text; invoices go through the injected template sender when one is given
//             (Meta only accepts templates outside the 24h customer-service window).
// All logic lives here against `CardTransport` (transport.ts) so it is testable without Photon.

import type { CardPresenter, CardSpec, Recipient, SentMessage } from "@rove/shared";
import type { SpectrumInstance } from "spectrum-ts";
import { createSpectrumTransport, recipientKey } from "./transport";
import type { CardHandle, CardTransport } from "./transport";

export type { CardHandle, CardTransport } from "./transport";
export { createSpectrumTransport } from "./transport";

/** Sends the approved `rove_invoice` WhatsApp template (owned by the agent runtime / Meta setup). */
export interface WhatsAppTemplateSender {
  invoice(to: Recipient, spec: CardSpec): Promise<SentMessage>;
}

export interface CardPresenterOptions {
  waTemplates?: WhatsAppTemplateSender;
}

interface StoredCard {
  messageId: string;
  handle: CardHandle;
}

export function createCardPresenter(transport: CardTransport, opts: CardPresenterOptions = {}): CardPresenter {
  /** `${recipientKey}|${spec.key}` → the original card send. In memory: lost on restart, then update() sends a new bubble. */
  const cards = new Map<string, StoredCard>();
  /** recipientKey → tail of that recipient's send chain. Different recipients never wait on each other. */
  const queues = new Map<string, Promise<unknown>>();

  /**
   * Run `task` after every earlier task for the same recipient has settled (resolved OR rejected),
   * so card order matches event order and one failed send never wedges the chain.
   */
  function enqueue<T>(to: Recipient, task: () => Promise<T>): Promise<T> {
    let key: string;
    try {
      key = recipientKey(to);
    } catch (err) {
      return Promise.reject(err);
    }
    const prev = queues.get(key) ?? Promise.resolve(); // tails never reject (see below)
    const run = prev.then(() => task());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key); // idle → drop the entry
    });
    return run;
  }

  const cardKey = (to: Recipient, spec: CardSpec) => `${recipientKey(to)}|${spec.key}`;

  // Unqueued bodies: only call these from inside enqueue().
  async function sendNow(to: Recipient, spec: CardSpec): Promise<SentMessage> {
    if (!transport.supportsCards(to.channel)) {
      if (spec.kind === "invoice" && opts.waTemplates) return opts.waTemplates.invoice(to, spec);
      const { messageId } = await transport.sendText(to, `${spec.fallbackText}\n${spec.url}`);
      return { messageId, edited: false };
    }
    const { messageId, handle } = await transport.sendCard(to, spec.url, spec.live, spec.layout);
    cards.set(cardKey(to, spec), { messageId, handle });
    return { messageId, edited: false };
  }

  async function updateNow(to: Recipient, spec: CardSpec): Promise<SentMessage | null> {
    if (!transport.supportsCards(to.channel)) {
      if (!spec.updateText) return null; // not worth a new message on a channel without edits
      const { messageId } = await transport.sendText(to, `${spec.updateText}\n${spec.url}`);
      return { messageId, edited: false };
    }
    const known = cards.get(cardKey(to, spec));
    if (!known) return sendNow(to, spec); // e.g. after a restart → new bubble, remembered from now on
    await transport.editCard(to, known.handle, spec.url, spec.live, spec.layout);
    return { messageId: known.messageId, edited: true };
  }

  return {
    send: (to, spec) => enqueue(to, () => sendNow(to, spec)),
    update: (to, spec) => enqueue(to, () => updateNow(to, spec)),
    text: (to, body) => enqueue(to, () => transport.sendText(to, body)),
    image: (to, png, name, caption) => enqueue(to, () => transport.sendImage(to, png, name, caption)),
  };
}

/** The production presenter: `createCardPresenter` over the real Spectrum transport. */
export function createSpectrumCardPresenter(spectrum: SpectrumInstance, opts: CardPresenterOptions = {}): CardPresenter {
  return createCardPresenter(createSpectrumTransport(spectrum), opts);
}
