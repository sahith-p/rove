// Pending actions: the safety core (docs/specs/agent.md §5). Owner: Saran · Task: SA-A3
//   propose_* tool → insertAction (5-min expiry) → confirm card + "👍 to …" / "Reply YES to …"
//   confirm (👍 | YES | card button | /w step-up) → claimAction CAS → worker (plain code, never the model)
//   events (withdrawal.updated, refund.completed) → settle → done/failed → confirm card edited
// The model has no confirming tool. claimAction is the only gate: a second 👍 finds the action already
// executing, so the worker is called exactly once.

import {
  format,
  PENDING_ACTION_TTL_MS,
  type Merchant,
  type PendingAction,
  type PendingActionArgs,
  type PendingActionKind,
  type Recipient,
} from "@rove/shared";
import { WorkerError, type ActionsService, type Deps } from "./ports";

type Outcome = Awaited<ReturnType<ActionsService["confirm"]>>["outcome"];

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function recipientOf(m: Merchant): Recipient {
  return { phone: m.phone, channel: m.channel };
}

function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-3)}` : a;
}

export function createActions(deps: Deps): ActionsService {
  const { store, worker, outbox, builders } = deps;
  const summaries = new Map<string, string>();

  const isPastExpiry = (a: PendingAction) => new Date(a.expiresAt).getTime() <= deps.now().getTime();

  async function isStepUp(a: PendingAction): Promise<boolean> {
    if (a.args.kind !== "withdrawal") return false;
    const w = await store.getWithdrawal(a.args.withdrawalId);
    return !!w?.needsStepUp;
  }

  async function summarize(action: PendingAction): Promise<string> {
    const args = action.args;
    switch (args.kind) {
      case "refund": {
        const payment = await store.getPayment(args.paymentId);
        let who = "";
        if (payment?.payer) {
          const contacts = await store.findContacts(action.merchantId);
          who = contacts.find((c) => c.phone === payment.payer!.phone)?.name ?? payment.payer.phone;
        }
        return `Refund ${format(args.amount)}${who ? ` to ${who}` : ""}`;
      }
      case "withdrawal": {
        const w = await store.getWithdrawal(args.withdrawalId);
        if (!w) return "Withdraw your balance";
        let label = "your bank";
        if (w.destination.kind === "xrpl_wallet") label = shortAddress(w.destination.address);
        else {
          const bank = await store.getDefaultBankAccount(action.merchantId);
          if (bank) label = `${bank.bankName ?? "PayNow"} ••••${bank.last4}`;
        }
        return `Withdraw ${format(w.amount)} to ${label}`;
      }
      case "set_auto_withdraw":
        return `Turn daily auto-withdraw ${args.mode === "daily" ? "on" : "off"}`;
    }
  }

  async function summaryOf(action: PendingAction): Promise<string> {
    const cached = summaries.get(action.id);
    if (cached) return cached;
    const s = await summarize(action);
    summaries.set(action.id, s);
    return s;
  }

  /** Edit the confirm card in place so it shows the action's current status. */
  async function refreshCard(action: PendingAction, merchant?: Merchant | null): Promise<void> {
    if (await isStepUp(action)) return; // step-up withdrawals have a withdrawal card, edited by events
    const m = merchant ?? (await store.getMerchant(action.merchantId));
    if (!m) return;
    try {
      const spec = builders.confirm({
        action,
        merchant: m,
        summary: await summaryOf(action),
        confirmToken: deps.confirmToken(action.id, m.id),
      });
      await outbox.cards.update(recipientOf(m), spec);
    } catch (err) {
      deps.log("actions: card update failed", action.id, err);
    }
  }

  async function tell(m: Merchant, body: string): Promise<void> {
    try {
      await outbox.text(recipientOf(m), body);
    } catch (err) {
      deps.log("actions: text failed", err);
    }
  }

  async function fresh(id: string, fallback: PendingAction): Promise<PendingAction> {
    return (await store.getAction(id)) ?? fallback;
  }

  async function propose(merchant: Merchant, kind: PendingActionKind, args: PendingActionArgs, summary: string): Promise<PendingAction> {
    const expiresAt = new Date(deps.now().getTime() + PENDING_ACTION_TTL_MS).toISOString();
    const action = await store.insertAction({ merchantId: merchant.id, kind, args, expiresAt });
    summaries.set(action.id, summary);
    const to = recipientOf(merchant);

    if (args.kind === "withdrawal") {
      const w = await store.getWithdrawal(args.withdrawalId);
      if (w?.needsStepUp) {
        const label = summary.replace(/^Withdraw [^ ]+ to /, "");
        const spec = builders.withdrawal({
          withdrawal: w,
          merchant,
          destinationLabel: label,
          sessionToken: deps.sessionToken(merchant.id, "withdrawal", w.id),
        });
        const card = await outbox.cards.send(to, spec);
        await outbox.text(to, `Confirm on the withdrawal page to send ${format(w.amount)}.`);
        await store.setActionMessageIds(action.id, [card.messageId]);
        return (await store.getAction(action.id)) ?? action;
      }
    }

    const spec = builders.confirm({ action, merchant, summary, confirmToken: deps.confirmToken(action.id, merchant.id) });
    const card = await outbox.cards.send(to, spec);
    const ask = merchant.channel === "imessage" ? `👍 to ${lowerFirst(summary)}` : `Reply YES to ${lowerFirst(summary)}`;
    const text = await outbox.text(to, ask);
    await store.setActionMessageIds(action.id, [card.messageId, text.messageId]);
    return (await store.getAction(action.id)) ?? action;
  }

  async function execute(action: PendingAction, merchant: Merchant, summary: string): Promise<Outcome> {
    const args = action.args;
    try {
      switch (args.kind) {
        case "withdrawal":
          // Stays `executing` until withdrawal.updated reaches completed/failed → settle().
          await worker.executeWithdrawal(args.withdrawalId, action.id);
          await refreshCard(await fresh(action.id, action), merchant);
          await tell(merchant, `On it ✓ ${summary}`);
          return "executing";
        case "refund": {
          const res = await worker.refund({ actionId: action.id, paymentId: args.paymentId, amount: args.amount.amount });
          if (res.status === "failed") throw new WorkerError("the refund was declined", 422);
          if (res.status === "completed") {
            await store.finishAction(action.id, "done", res);
            await refreshCard(await fresh(action.id, action), merchant);
            await tell(merchant, `Done ✓ ${summary}`);
            return "done";
          }
          // pending → refund.completed event settles it
          await refreshCard(await fresh(action.id, action), merchant);
          await tell(merchant, `On it ✓ ${summary}`);
          return "executing";
        }
        case "set_auto_withdraw":
          await worker.setAutoWithdraw(action.merchantId, args.mode);
          await store.finishAction(action.id, "done", { mode: args.mode });
          await refreshCard(await fresh(action.id, action), merchant);
          await tell(merchant, `Done ✓ ${summary}`);
          return "done";
      }
    } catch (err) {
      const reason = err instanceof WorkerError ? err.message : "something went wrong on our side";
      deps.log("actions: execute failed", action.id, err);
      await store.finishAction(action.id, "failed", { error: reason });
      await refreshCard(await fresh(action.id, action), merchant);
      await tell(merchant, `That didn't go through: ${reason}. Nothing moved.`);
      return "failed";
    }
  }

  async function confirm(actionId: string, via: "tapback" | "reply" | "card" | "web") {
    const action = await store.getAction(actionId);
    if (!action) {
      // Placeholder so the response shape holds; callers check `outcome` first.
      const placeholder: PendingAction = {
        id: actionId,
        merchantId: "",
        kind: "set_auto_withdraw",
        args: { kind: "set_auto_withdraw", mode: "off" },
        status: "cancelled",
        confirmMessageIds: [],
        expiresAt: deps.now().toISOString(),
        createdAt: deps.now().toISOString(),
      };
      return { action: placeholder, summary: "", outcome: "not_found" as const };
    }
    const summary = await summaryOf(action);
    if (action.status === "executing" || action.status === "done") return { action, summary, outcome: "already" as const };
    if (action.status === "failed" || action.status === "cancelled") return { action, summary, outcome: "failed" as const };
    if (action.status === "expired" || isPastExpiry(action)) return { action, summary, outcome: "expired" as const };

    const merchant = await store.getMerchant(action.merchantId);
    if (!merchant) return { action, summary, outcome: "not_found" as const };

    if ((via === "tapback" || via === "reply") && (await isStepUp(action))) {
      await tell(merchant, "Please confirm this one on the withdrawal page.");
      return { action, summary, outcome: "failed" as const };
    }

    if (!(await store.claimAction(action.id))) {
      const now = await fresh(action.id, action);
      const outcome: Outcome = now.status === "expired" || isPastExpiry(now) ? "expired" : "already";
      return { action: now, summary, outcome };
    }
    deps.log(`actions: ${action.id} confirmed via ${via}`);
    const outcome = await execute(await fresh(action.id, action), merchant, summary);
    return { action: await fresh(action.id, action), summary, outcome };
  }

  async function confirmByMessageId(messageId: string, by: Recipient): Promise<boolean> {
    const action = await store.findActionByMessageId(messageId);
    if (!action) return false;
    const merchant = await store.getMerchant(action.merchantId);
    if (!merchant || merchant.phone !== by.phone) return false;
    if (action.status === "expired" || (action.status === "proposed" && isPastExpiry(action))) {
      await tell(merchant, "This expired. Ask me again.");
      return true;
    }
    if (action.status !== "proposed") return true; // already handled; a second 👍 does nothing
    await confirm(action.id, "tapback");
    return true;
  }

  async function confirmLatest(merchant: Merchant, _from: Recipient): Promise<boolean> {
    const open = (await store.findOpenActionsForMerchant(merchant.id)).filter((a) => a.status === "proposed" && !isPastExpiry(a));
    if (open.length === 0) return false;
    if (open.length > 1) {
      const list = (await Promise.all(open.map(summaryOf))).map((s, i) => `${i + 1}) ${s}`).join(", ");
      const how = merchant.channel === "imessage" ? "👍 the one you want" : "Tell me which one";
      await tell(merchant, `You have ${open.length} things waiting: ${list}. ${how}.`);
      return true;
    }
    await confirm(open[0]!.id, "reply");
    return true;
  }

  async function settle(ref: string, status: "done" | "failed", result?: unknown): Promise<void> {
    const action = await store.findActionByRef(ref);
    if (!action || action.status !== "executing") return;
    await store.finishAction(action.id, status, result);
    await refreshCard(await fresh(action.id, action));
  }

  async function sweep(): Promise<void> {
    const expired = await store.expireActions();
    for (const a of expired) {
      await refreshCard(a);
      summaries.delete(a.id);
    }
  }

  return { propose, confirm, confirmByMessageId, confirmLatest, settle, sweep, summarize };
}
