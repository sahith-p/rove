// Events from the worker / web API → messages and card edits. Owner: Saran (SA-A2).
// Spec: docs/02-contracts.md "Events → what the agent does". At-least-once delivery: dedupe on envelope id.
// Onboarding gets first look (it owns shop.updated / merchant.live / bank_account.added while a shop is being set up).

import { format, zero, type EventEnvelope, type Merchant, type Recipient, type RoveEvent, type Withdrawal } from "@rove/shared";
import type { ActionsService, Deps, EventsHandler, OnboardingFlow } from "./ports";

type EventOf<T extends RoveEvent["type"]> = Extract<RoveEvent, { type: T }>;

const recipientOf = (m: Merchant): Recipient => ({ phone: m.phone, channel: m.channel });

export function createEventsHandler(deps: Deps, m: { actions: ActionsService; onboarding: OnboardingFlow }): EventsHandler {
  const { store, outbox, builders } = deps;

  /** One failing send must not stop the rest of the handler. */
  async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      deps.log(`[events] ${label} failed`, err);
    }
  }

  async function merchantOrNull(id: string): Promise<Merchant | null> {
    const merchant = await store.getMerchant(id);
    if (!merchant) deps.log(`[events] unknown merchant ${id}`);
    return merchant;
  }

  async function payerName(merchantId: string, phone: string): Promise<string> {
    const contacts = await store.findContacts(merchantId);
    return contacts.find((c) => c.phone === phone)?.name ?? "a customer";
  }

  async function destinationLabel(w: Withdrawal): Promise<string> {
    if (w.destination.kind === "xrpl_wallet") {
      const a = w.destination.address;
      return `${a.slice(0, 4)}…${a.slice(-3)}`;
    }
    const bank = await store.getDefaultBankAccount(w.merchantId);
    return bank ? `${bank.bankName ?? "PayNow"} ••••${bank.last4}` : "your bank";
  }

  async function paymentSettled(e: EventOf<"payment.settled">) {
    const merchant = await merchantOrNull(e.merchantId);
    const payment = await store.getPayment(e.paymentId);
    if (!merchant || !payment) return;
    const to = recipientOf(merchant);
    const who = e.payer ? await payerName(merchant.id, e.payer.phone) : "a customer";

    await safe("sale card", () =>
      outbox.cards.send(to, builders.sale({ payment, merchant, sessionToken: deps.sessionToken(merchant.id, "sale", payment.id) })),
    );
    if (e.firstSale) await safe("first sale effect", () => outbox.effect(to, `Your first sale! 🎉 ${format(e.local)} from ${who}. Here's to many more.`, "confetti"));

    if (!e.payer) return;
    const payer = e.payer;
    if (e.invoiceId) {
      const invoice = await store.getInvoice(e.invoiceId);
      if (invoice) await safe("invoice card paid", () => outbox.cards.update(payer, builders.invoice({ invoice, merchant })));
    }
    await safe("receipt card", () => outbox.cards.send(payer, builders.receipt({ payment, merchant })));
  }

  async function paymentFailed(e: EventOf<"payment.failed">) {
    const merchant = await merchantOrNull(e.merchantId);
    if (merchant) await safe("failed text merchant", () => outbox.text(recipientOf(merchant), "Heads up: a payment didn't go through, so the customer wasn't charged."));
    const payment = await store.getPayment(e.paymentId);
    if (payment?.payer) {
      const payer = payment.payer;
      await safe("failed text payer", () => outbox.text(payer, "Sorry, that payment didn't go through, and you weren't charged. Want to give it another go?"));
    }
  }

  async function refundCompleted(e: EventOf<"refund.completed">) {
    await safe("settle refund action", () => m.actions.settle(e.paymentId, "done", { refundId: e.refundId }));
    const merchant = await merchantOrNull(e.merchantId);
    if (!merchant) return;
    const payment = await store.getPayment(e.paymentId);
    if (payment) {
      await safe("sale card refunded", () =>
        outbox.cards.update(
          recipientOf(merchant),
          builders.sale({ payment, merchant, sessionToken: deps.sessionToken(merchant.id, "sale", payment.id) }),
        ),
      );
    }
    const payer = e.payer ?? payment?.payer ?? null;
    if (payer) await safe("refund text payer", () => outbox.text(payer, `Good news: ${merchant.name} refunded you ${format(e.amount)}. It'll show up on your card soon.`));
  }

  async function refundFailed(e: EventOf<"refund.failed">) {
    await safe("settle refund action", () => m.actions.settle(e.paymentId, "failed", { reason: e.reason }));
    const merchant = await merchantOrNull(e.merchantId);
    if (merchant) await safe("refund failed text", () => outbox.text(recipientOf(merchant), `The refund didn't go through: ${e.reason}`));
  }

  async function withdrawalUpdated(e: EventOf<"withdrawal.updated">) {
    const merchant = await merchantOrNull(e.merchantId);
    if (!merchant) return;
    const now = deps.now().toISOString();
    const withdrawal: Withdrawal = (await store.getWithdrawal(e.withdrawalId)) ?? {
      id: e.withdrawalId,
      merchantId: e.merchantId,
      amount: e.amount,
      fee: zero(e.amount.currency),
      destination: { kind: "bank", bankAccountId: "" },
      status: e.status,
      needsStepUp: false,
      createdAt: now,
      updatedAt: now,
      ...(e.sweepTxHash ? { sweepTxHash: e.sweepTxHash } : {}),
      ...(e.bankRef ? { bankRef: e.bankRef } : {}),
      ...(e.failureReason ? { failureReason: e.failureReason } : {}),
    };
    // The event is the newest truth for status even if the row read raced it.
    const current: Withdrawal = { ...withdrawal, status: e.status, bankRef: e.bankRef ?? withdrawal.bankRef, failureReason: e.failureReason ?? withdrawal.failureReason };
    const to = recipientOf(merchant);
    const label = await destinationLabel(current);

    await safe("withdrawal card", () =>
      outbox.cards.update(
        to,
        builders.withdrawal({ withdrawal: current, merchant, destinationLabel: label, sessionToken: deps.sessionToken(merchant.id, "withdrawal", current.id) }),
      ),
    );

    const amount = format(e.amount);
    if (e.status === "completed" || (e.status === "onchain_settled" && current.destination.kind === "xrpl_wallet")) {
      // Wallet withdrawals can report both onchain_settled and completed: announce the arrival once.
      if (!(await store.claim(`withdrawal-done:${e.withdrawalId}`))) return;
      await safe("settle withdrawal action", () => m.actions.settle(e.withdrawalId, "done", { bankRef: e.bankRef }));
      const body =
        current.destination.kind === "xrpl_wallet"
          ? `${amount} just landed in your wallet ✓`
          : `${amount} is in your bank 🎉${current.bankRef ? ` (ref ${current.bankRef} · simulated payout)` : " (simulated payout)"}`;
      await safe("withdrawal done text", () => outbox.text(to, body));
    } else if (e.status === "failed" || e.status === "returned" || e.status === "cancelled") {
      await safe("settle withdrawal action", () => m.actions.settle(e.withdrawalId, "failed", { reason: e.failureReason }));
      const reason = current.failureReason ? `: ${current.failureReason}` : "";
      await safe("withdrawal failed text", () => outbox.text(to, `Your ${amount} withdrawal didn't go through${reason}. Don't worry, the money's back in your balance.`));
    }
  }

  async function merchantLive(e: EventOf<"merchant.live">) {
    const merchant = await merchantOrNull(e.merchantId);
    if (!merchant) return;
    const to = recipientOf(merchant);
    await safe("live effect", () => outbox.effect(to, "You're live! 🎉 Welcome to Rove.", "confetti"));
    await safe("sticker", async () => {
      const url = deps.links.shop(merchant.id);
      const png = await deps.qr.stickerPng({ name: merchant.name, url, verified: merchant.credentialStatus === "accepted", shopCode: merchant.id });
      if (png) await outbox.image(to, png, `${merchant.id}-sticker.png`, `Here's your shop QR. Stick it up by the counter: customers scan it, or text "pay ${merchant.id}".`);
      else await outbox.text(to, `Your shop link: ${url} · customers can also text "pay ${merchant.id} <amount>".`);
    });
    await safe("bank card", () => outbox.cards.send(to, builders.bank({ merchant, sessionToken: deps.sessionToken(merchant.id, "bank") })));
  }

  async function shopUpdated(e: EventOf<"shop.updated">) {
    const merchant = await merchantOrNull(e.merchantId);
    if (!merchant) return;
    const menu = await store.listMenu(merchant.id);
    await safe("setup card", () =>
      outbox.cards.update(recipientOf(merchant), builders.setup({ merchant, menu, sessionToken: deps.sessionToken(merchant.id, "setup") })),
    );
  }

  async function bankAdded(e: EventOf<"bank_account.added">) {
    const merchant = await merchantOrNull(e.merchantId);
    if (merchant) await safe("bank saved text", () => outbox.text(recipientOf(merchant), `Got it, ${e.label} is saved ✓ You can withdraw anytime now.`));
  }

  async function dispatch(event: RoveEvent): Promise<void> {
    switch (event.type) {
      case "payment.settled":
        return paymentSettled(event);
      case "payment.failed":
        return paymentFailed(event);
      case "refund.completed":
        return refundCompleted(event);
      case "refund.failed":
        return refundFailed(event);
      case "withdrawal.updated":
        return withdrawalUpdated(event);
      case "merchant.live":
        return merchantLive(event);
      case "shop.updated":
        return shopUpdated(event);
      case "bank_account.added":
        return bankAdded(event);
    }
  }

  return {
    async handle(envelope: EventEnvelope) {
      if (!(await store.claim(`event:${envelope.id}`))) return "duplicate";
      let handledByOnboarding = false;
      try {
        handledByOnboarding = await m.onboarding.onEvent(envelope.event);
      } catch (err) {
        deps.log("[events] onboarding.onEvent failed", err);
      }
      if (!handledByOnboarding) {
        try {
          await dispatch(envelope.event);
        } catch (err) {
          deps.log(`[events] ${envelope.event.type} failed`, err);
        }
      }
      return "handled";
    },
  };
}
