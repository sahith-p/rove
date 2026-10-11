// Pure CardSpec builders for all 9 card kinds. Owner: Sahith (task SH-B1). Spec: docs/specs/imessage-apps.md §3
// URL from `links(PUBLIC_BASE_URL)` + `v=<state>` (changes whenever the visible state changes, so iMessage refetches).

import { format, links } from "@rove/shared";
import type { CardBuilders, CardLayout, CardSpec, MenuItem, PaymentStatus, WithdrawalStatus } from "@rove/shared";

/** Build a CardSpec, leaving `updateText` out entirely when there is nothing worth a new message. */
function card(spec: Omit<CardSpec, "updateText"> & { updateText?: string | undefined }): CardSpec {
  const { updateText, ...rest } = spec;
  return updateText === undefined ? rest : { ...rest, updateText };
}

/** Set query params on an absolute URL, whether or not it already has a query string. */
export function withParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
  return u.toString();
}

/** Human label for each withdrawal status, used in the withdrawal card's fallback text. */
export const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  requested: "waiting for your confirmation",
  approved: "approved",
  onchain_pending: "sending on XRPL",
  onchain_settled: "on XRPL ✓",
  payout_pending: "sent to bank",
  completed: "in your bank ✓",
  failed: "failed",
  returned: "returned",
  cancelled: "cancelled",
};

/** Number of menu items a customer can actually order. */
export function activeItemCount(menu: MenuItem[]): number {
  return menu.filter((item) => item.active).length;
}

function isRefunded(status: PaymentStatus): boolean {
  return status === "refunded" || status === "partially_refunded";
}

export function createCardBuilders({ baseUrl }: { baseUrl: string }): CardBuilders {
  const l = links(baseUrl);

  const builders: CardBuilders = {
    setup({ merchant, menu, sessionToken }) {
      return card({
        kind: "setup",
        key: `setup:${merchant.id}`,
        url: withParams(l.setup(sessionToken), { v: String(activeItemCount(menu)) }),
        live: true,
        fallbackText: `Set up ${merchant.name}: add your menu and details here.`,
      });
    },

    bank({ merchant, sessionToken }) {
      return card({
        kind: "bank",
        key: `bank:${merchant.id}`,
        url: l.bank(sessionToken),
        live: true,
        fallbackText: "Add your bank account so you can withdraw (secure form, link valid 15 min).",
      });
    },

    shop({ merchant, sessionToken }) {
      return card({
        kind: "shop",
        key: `shop:${merchant.id}`,
        url: l.myShop(sessionToken),
        live: true,
        fallbackText: `${merchant.name}: balance, payments, invoices and menu.`,
      });
    },

    menu({ merchant, menu }) {
      return card({
        kind: "menu",
        key: `menu:${merchant.id}`,
        url: withParams(l.shop(merchant.id), { v: String(activeItemCount(menu)) }),
        live: true,
        fallbackText: `${merchant.name} menu: tap to order and pay.`,
      });
    },

    invoice({ invoice, merchant }) {
      const total = format(invoice.total);
      const note = invoice.note ? ` Note: ${invoice.note}` : "";
      return card({
        kind: "invoice",
        key: `invoice:${invoice.id}`,
        url: withParams(l.pay(invoice.code), { v: invoice.status }),
        live: true,
        fallbackText: `${merchant.name} sent you a request for ${total}.${note}`,
        updateText: invoice.status === "paid" ? `Paid ✓ ${total} to ${merchant.name}.` : undefined,
      });
    },

    receipt({ payment, merchant }) {
      return card({
        kind: "receipt",
        key: `receipt:${payment.id}`,
        url: withParams(l.receipt(payment.id), { v: payment.status }),
        live: true,
        fallbackText: `Receipt: ${format(payment.local)} paid to ${merchant.name}.`,
        updateText: isRefunded(payment.status) ? `${merchant.name} refunded ${format(payment.refunded)}.` : undefined,
      });
    },

    sale({ payment, sessionToken }) {
      return card({
        kind: "sale",
        key: `sale:${payment.id}`,
        url: withParams(l.receipt(payment.id), { view: "merchant", t: sessionToken, v: payment.status }),
        live: true,
        fallbackText: `${format(payment.local)} from ${payment.payer?.phone ?? "a customer"} ✓`,
        updateText: isRefunded(payment.status) ? `Refunded ${format(payment.refunded)}.` : undefined,
      });
    },

    withdrawal({ withdrawal, destinationLabel, sessionToken, actionId, confirmToken }) {
      const amount = format(withdrawal.amount);
      let updateText: string | undefined;
      switch (withdrawal.status) {
        case "completed":
          updateText =
            withdrawal.destination.kind === "xrpl_wallet"
              ? `Sent ${amount} to your wallet ✓`
              : (withdrawal.bankRef ? `In your bank ✓ ${amount} · ${withdrawal.bankRef}` : `In your bank ✓ ${amount}`);
          break;
        case "failed":
          updateText = `Withdrawal failed: ${withdrawal.failureReason ?? "unknown"}. Money is back in your balance.`;
          break;
        case "returned":
          updateText = `Bank returned the withdrawal. ${amount} is back in your balance.`;
          break;
      }
      return card({
        kind: "withdrawal",
        key: `withdrawal:${withdrawal.id}`,
        url: withParams(l.withdrawal(withdrawal.id, sessionToken), {
          v: withdrawal.status,
          ...(actionId && confirmToken ? { a: actionId, c: confirmToken } : {}),
        }),
        live: true,
        fallbackText: `Withdrawal of ${amount} to ${destinationLabel}: ${WITHDRAWAL_STATUS_LABEL[withdrawal.status]}.`,
        updateText,
      });
    },

    confirm({ action, summary, confirmToken }) {
      let updateText: string | undefined;
      switch (action.status) {
        case "done":
          updateText = `Done ✓ ${summary}`;
          break;
        case "expired":
          updateText = `Expired: ${summary}. Ask me again.`;
          break;
        case "failed":
          updateText = `Failed: ${summary}.`;
          break;
      }
      return card({
        kind: "confirm",
        key: `confirm:${action.id}`,
        url: withParams(l.confirm(action.id, confirmToken), { v: action.status }),
        live: true,
        fallbackText: `${summary} — tap to confirm.`,
        updateText,
      });
    },
  };

  // Every card URL carries card=1 so the page renders its compact, no-scroll card layout inside the iMessage webview.
  const inCard = <K extends keyof CardBuilders>(k: K) =>
    ((v: Parameters<CardBuilders[K]>[0]) => {
      const spec = (builders[k] as (x: typeof v) => CardSpec)(v);
      return { ...spec, url: withParams(spec.url, { card: "1" }), layout: layoutFor(k, v as never, spec) };
    }) as CardBuilders[K];
  return {
    setup: inCard("setup"), bank: inCard("bank"), shop: inCard("shop"), menu: inCard("menu"), invoice: inCard("invoice"),
    receipt: inCard("receipt"), sale: inCard("sale"), withdrawal: inCard("withdrawal"), confirm: inCard("confirm"),
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const PAYMENT_PILL: Partial<Record<PaymentStatus, string>> = {
  settled: "Paid ✓", refunded: "Refunded", partially_refunded: "Part refunded", failed: "Failed",
  created: "Pending", authorized: "Processing", settling: "Settling",
};
const WITHDRAWAL_PILL: Record<WithdrawalStatus, string> = {
  requested: "Confirm", approved: "Approved", onchain_pending: "On XRPL…", onchain_settled: "On XRPL ✓",
  payout_pending: "Sent to bank", completed: "In bank ✓", failed: "Failed", returned: "Returned", cancelled: "Cancelled",
};

/** Bubble text for the Rove-branded customized card. Short: iMessage truncates around ~28 chars per slot. */
export function layoutFor<K extends keyof CardBuilders>(kind: K, v: Parameters<CardBuilders[K]>[0], spec: CardSpec): CardLayout {
  const summary = spec.fallbackText;
  const a = v as Record<string, any>;
  switch (kind) {
    case "setup": {
      const n = activeItemCount(a.menu as MenuItem[]);
      return { caption: clip(a.merchant.name, 28), subcaption: n ? `${n} item${n === 1 ? "" : "s"} · tap to edit` : "Add your menu", trailingCaption: "Shop", summary };
    }
    case "bank":
      return { caption: "Add your bank", subcaption: "Secure form · 15 min", trailingCaption: "Secure", summary };
    case "shop":
      return { caption: clip(a.merchant.name, 28), subcaption: "Balance · payments · menu", trailingCaption: "My shop", summary };
    case "menu": {
      const n = activeItemCount(a.menu as MenuItem[]);
      return { caption: clip(a.merchant.name, 28), subcaption: `${n} items · tap to order`, trailingCaption: "Menu", summary };
    }
    case "invoice": {
      const inv = a.invoice;
      const items = (inv.lines as { name: string; qty: number }[]).map((l) => `${l.qty}× ${l.name}`).join(", ");
      const pill = inv.status === "paid" ? "Paid ✓" : inv.status === "expired" ? "Expired" : inv.status === "cancelled" ? "Cancelled" : "Tap to pay";
      return { caption: clip(a.merchant.name, 28), subcaption: clip(items || inv.note || `Code ${inv.code}`, 32), trailingCaption: format(inv.total), trailingSubcaption: pill, summary };
    }
    case "receipt":
      return { caption: clip(a.merchant.name, 28), subcaption: "Receipt", trailingCaption: format(a.payment.local), trailingSubcaption: PAYMENT_PILL[a.payment.status as PaymentStatus] ?? "", summary };
    case "sale":
      return { caption: "New sale", subcaption: a.payment.payer?.phone ? `From ${a.payment.payer.phone}` : "From a customer", trailingCaption: format(a.payment.local), trailingSubcaption: PAYMENT_PILL[a.payment.status as PaymentStatus] ?? "", summary };
    case "withdrawal":
      return { caption: "Withdrawal", subcaption: clip(a.destinationLabel, 30), trailingCaption: format(a.withdrawal.amount), trailingSubcaption: WITHDRAWAL_PILL[a.withdrawal.status as WithdrawalStatus], summary };
    case "confirm":
      return { caption: clip(a.summary, 30), subcaption: "Tap to confirm · 5 min", trailingCaption: "Confirm", summary };
    default:
      return { summary };
  }
}
