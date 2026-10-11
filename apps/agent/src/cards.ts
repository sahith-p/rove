// Card builders + QR images + a basic Spectrum presenter.
// Sahith owns the real ones (@rove/imessage-apps: SH-B1 builders, SH-B4 presenter, SH-B6 QR images). Until his
// land, each builder method falls back to the local implementation below (same keys + URLs as docs/02 Cards), so
// the agent can run end to end on phones today. Once his methods stop throwing, they win automatically.

import { createCardBuilders, qrPng, stickerPng } from "@rove/imessage-apps";
import { format, links, type CardBuilders, type CardPresenter, type CardSpec, type Recipient } from "@rove/shared";
import type { QrImages } from "./ports";

type Builder = keyof CardBuilders;

export function createBuilders(baseUrl: string): CardBuilders {
  const local = createLocalBuilders(baseUrl);
  let real: CardBuilders | null = null;
  try {
    real = createCardBuilders({ baseUrl });
  } catch {
    real = null;
  }
  const pick = <K extends Builder>(name: K): CardBuilders[K] =>
    ((v: Parameters<CardBuilders[K]>[0]) => {
      if (real) {
        try {
          return (real[name] as (x: typeof v) => CardSpec)(v);
        } catch (err) {
          if (!(err instanceof Error && /not implemented/i.test(err.message))) throw err;
        }
      }
      return (local[name] as (x: typeof v) => CardSpec)(v);
    }) as CardBuilders[K];
  return {
    setup: pick("setup"),
    bank: pick("bank"),
    shop: pick("shop"),
    menu: pick("menu"),
    invoice: pick("invoice"),
    receipt: pick("receipt"),
    sale: pick("sale"),
    withdrawal: pick("withdrawal"),
    confirm: pick("confirm"),
  };
}

const withV = (url: string, v: string | number) => `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(v))}`;

const WITHDRAWAL_TEXT: Record<string, string> = {
  requested: "waiting for your confirmation",
  approved: "confirmed",
  onchain_pending: "moving on XRPL",
  onchain_settled: "on XRPL",
  payout_pending: "sent to bank",
  completed: "in your bank ✓",
  failed: "failed; nothing left your balance",
  returned: "the bank rejected it; the money is back in your balance",
  cancelled: "cancelled",
};

/** Local CardBuilders (docs/02 Cards table). */
export function createLocalBuilders(baseUrl: string): CardBuilders {
  const l = links(baseUrl);
  return {
    setup: ({ merchant, menu, sessionToken }) => ({
      kind: "setup",
      key: `setup:${merchant.id}`,
      url: withV(l.setup(sessionToken), menu.length),
      live: true,
      fallbackText: `Set up ${merchant.name}: name, category and menu`,
      updateText: menu.length ? `Menu saved: ${menu.length} item${menu.length === 1 ? "" : "s"} ✓` : undefined,
    }),
    bank: ({ merchant, sessionToken }) => ({
      kind: "bank",
      key: `bank:${merchant.id}`,
      url: l.bank(sessionToken),
      live: true,
      fallbackText: `Add your bank for ${merchant.name} (secure form; bank details never go in chat)`,
    }),
    shop: ({ merchant, sessionToken }) => ({
      kind: "shop",
      key: `shop:${merchant.id}`,
      url: l.myShop(sessionToken),
      live: true,
      fallbackText: `${merchant.name}: your shop`,
    }),
    menu: ({ merchant, menu }) => ({
      kind: "menu",
      key: `menu:${merchant.id}`,
      url: withV(l.shop(merchant.id), menu.length),
      live: false,
      fallbackText: `${merchant.name} menu: ${menu.map((m) => `${m.name} ${format(m.price)}`).join(", ") || "pay any amount"}`,
    }),
    invoice: ({ invoice, merchant }) => ({
      kind: "invoice",
      key: `invoice:${invoice.id}`,
      url: withV(l.pay(invoice.code), invoice.status),
      live: true,
      fallbackText:
        invoice.kind === "pay_request"
          ? `Pay ${merchant.name} ${format(invoice.total)}`
          : `${merchant.name} sent you a request for ${format(invoice.total)}`,
      updateText: invoice.status === "paid" ? `Paid ✓ ${format(invoice.total)} to ${merchant.name}` : undefined,
    }),
    receipt: ({ payment, merchant }) => ({
      kind: "receipt",
      key: `receipt:${payment.id}`,
      url: withV(l.receipt(payment.id), payment.status),
      live: false,
      fallbackText: `Receipt: ${format(payment.local)} to ${merchant.name}`,
    }),
    sale: ({ payment, sessionToken }) => ({
      kind: "sale",
      key: `sale:${payment.id}`,
      url: withV(`${l.receipt(payment.id)}?view=merchant&t=${sessionToken}`, payment.status),
      live: false,
      fallbackText: `${format(payment.local)} received · ${payment.status}`,
      updateText: payment.status === "refunded" || payment.status === "partially_refunded" ? `Refunded ${format(payment.refunded)}` : undefined,
    }),
    withdrawal: ({ withdrawal, destinationLabel, sessionToken }) => ({
      kind: "withdrawal",
      key: `withdrawal:${withdrawal.id}`,
      url: withV(l.withdrawal(withdrawal.id, sessionToken), withdrawal.status),
      live: true,
      fallbackText: `Withdraw ${format(withdrawal.amount)} to ${destinationLabel}: ${WITHDRAWAL_TEXT[withdrawal.status] ?? withdrawal.status}`,
      updateText:
        withdrawal.status === "completed" || withdrawal.status === "failed" || withdrawal.status === "returned"
          ? `${format(withdrawal.amount)} to ${destinationLabel}: ${WITHDRAWAL_TEXT[withdrawal.status]}${withdrawal.bankRef ? ` (${withdrawal.bankRef})` : ""}`
          : undefined,
    }),
    confirm: ({ action, summary, confirmToken }) => ({
      kind: "confirm",
      key: `confirm:${action.id}`,
      url: withV(l.confirm(action.id, confirmToken), action.status),
      live: true,
      fallbackText: `Confirm: ${summary}`,
      updateText:
        action.status === "done" ? `Done ✓ ${summary}` : action.status === "expired" ? `Expired: ${summary}` : action.status === "failed" ? `Failed: ${summary}` : undefined,
    }),
  };
}

/** QR PNGs from Sahith's qr.ts (SH-B6). A render failure returns null → the agent sends the link as text. */
export function createQrImages(log: (...a: unknown[]) => void = console.warn): QrImages {
  return {
    async qrPng(url) {
      try {
        return await qrPng(url);
      } catch (err) {
        log("qrPng failed", err);
        return null;
      }
    },
    async stickerPng(v) {
      try {
        return await stickerPng(v);
      } catch (err) {
        log("stickerPng failed", err);
        return null;
      }
    },
  };
}

// ------------------------------------------------------------------ basic Spectrum presenter (fallback for SH-B4)

/** Minimal surface of a Spectrum space / message the fallback presenter needs. */
export interface SpaceLike {
  send(content: unknown): Promise<{ id: string } | undefined>;
}
export type MessageHandle = { id: string };

export interface BasicPresenterDeps {
  spaceFor(to: Recipient): Promise<SpaceLike>;
  /** Spectrum content builders, injected so this file doesn't depend on provider wiring. */
  app(url: string, opts: { live: boolean }): unknown;
  edit(content: unknown, target: MessageHandle): unknown;
  attachment(png: Buffer, opts: { name: string; mimeType: string }): unknown;
}

/** Used only while @rove/imessage-apps createSpectrumCardPresenter throws "not implemented". */
export function createBasicSpectrumPresenter(d: BasicPresenterDeps): CardPresenter {
  const handles = new Map<string, MessageHandle>(); // `${phone}|${key}` → first message
  const k = (to: Recipient, spec: CardSpec) => `${to.phone}|${spec.key}`;
  const sendText = async (to: Recipient, body: string) => {
    const msg = await (await d.spaceFor(to)).send(body);
    return { messageId: msg?.id ?? `unsent-${Date.now()}` };
  };
  return {
    async send(to, spec) {
      const msg = await (await d.spaceFor(to)).send(d.app(spec.url, { live: spec.live }));
      if (msg) handles.set(k(to, spec), msg);
      return { messageId: msg?.id ?? `unsent-${Date.now()}`, edited: false };
    },
    async update(to, spec) {
      const original = handles.get(k(to, spec));
      if (!original) return this.send(to, spec);
      await (await d.spaceFor(to)).send(d.edit(d.app(spec.url, { live: spec.live }), original));
      return { messageId: original.id, edited: true };
    },
    text: sendText,
    async image(to, png, name, caption) {
      const space = await d.spaceFor(to);
      const msg = await space.send(d.attachment(Buffer.from(png), { name, mimeType: "image/png" }));
      if (caption) await space.send(caption);
      return { messageId: msg?.id ?? `unsent-${Date.now()}` };
    },
  };
}
