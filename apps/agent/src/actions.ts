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

/** Friendly text for an action's progress, from its summary ("Withdraw S$15.00 to DBS ••••1234", "Refund S$12.50 to Maya", "Turn daily auto-withdraw on"). */
function progressText(summary: string, phase: "executing" | "done"): string {
  const w = /^Withdraw (\S+) to (.+)$/.exec(summary);
  if (w) return phase === "executing" ? `On it! Sending ${w[1]} to ${w[2]}. The card will update as it moves.` : `Done! ${w[1]} is on its way to ${w[2]}.`;
  const r = /^Refund (\S+)(?: to (.+))?$/.exec(summary);
  if (r) return phase === "executing" ? `On it! Refunding ${r[1]}${r[2] ? ` to ${r[2]}` : ""} now.` : `Done ✓ Refunded ${r[1]}${r[2] ? ` to ${r[2]}` : ""}.`;
  const a = /auto-withdraw/i.test(summary) ? /\b(on|off)\b/i.exec(summary) : null;
  if (a) return a[1]!.toLowerCase() === "on" ? "Done ✓ Daily auto-withdraw is on, so your balance goes to your bank every night." : "Done ✓ Auto-withdraw is off. Your money stays put until you ask.";
  return phase === "executing" ? `On it! ${summary}.` : `Done ✓ ${summary}.`;
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
          actionId: action.id,
          confirmToken: deps.confirmToken(action.id, merchant.id),
        });
        const card = await outbox.cards.send(to, spec);
        await outbox.text(to, `This one needs a quick extra check: tap the card to confirm sending ${format(w.amount)}.`);
        await store.setActionMessageIds(action.id, [card.messageId]);
        return (await store.getAction(action.id)) ?? action;
      }
    }

    const spec = builders.confirm({ action, merchant, summary, confirmToken: deps.confirmToken(action.id, merchant.id) });
    const card = await outbox.cards.send(to, spec);
    const ask = merchant.channel === "imessage" ? `👍 this and I'll ${lowerFirst(summary)}.` : `Reply YES and I'll ${lowerFirst(summary)}.`;
    const text = await outbox.text(to, ask);
    await store.setActionMessageIds(action.id, [card.messageId, text.messageId]);
    return (await store.getAction(action.id)) ?? action;
  }

  async function execute(action: PendingAction, merchant: Merchant, summary: string): Promise<Outcome> {
    const args = action.args;
    try {
      switch (args.kind) {
        case "withdrawal":
          // Stays `executing` until withdrawal.updated reaches completed/failed → settle(), which edits the card.
          await worker.executeWithdrawal(args.withdrawalId, action.id);
          {
            const now = await fresh(action.id, action);
            if (now.status !== "executing") return now.status === "done" ? "done" : "failed"; // the pipeline's events got there first
            await refreshCard(now, merchant);
            await tell(merchant, progressText(summary, "executing"));
          }
          return "executing";
        case "refund": {
          const res = await worker.refund({ actionId: action.id, paymentId: args.paymentId, amount: args.amount.amount });
          if (res.status === "failed") throw new WorkerError("the refund was declined", 422);
          if (res.status === "completed") {
            await store.finishAction(action.id, "done", res);
            await refreshCard(await fresh(action.id, action), merchant);
            await tell(merchant, progressText(summary, "done"));
            return "done";
          }
          // pending → refund.completed event settles it
          await refreshCard(await fresh(action.id, action), merchant);
          await tell(merchant, progressText(summary, "executing"));
          return "executing";
        }
        case "set_auto_withdraw":
          await worker.setAutoWithdraw(action.merchantId, args.mode);
          await store.finishAction(action.id, "done", { mode: args.mode });
          await refreshCard(await fresh(action.id, action), merchant);
          await tell(merchant, progressText(summary, "done"));
          return "done";
      }
    } catch (err) {
      const reason = err instanceof WorkerError && err.status < 500 ? err.message : "Rove's payment service didn't answer";
      deps.log("actions: execute failed", action.id, err);
      await store.finishAction(action.id, "failed", { error: reason });
      await refreshCard(await fresh(action.id, action), merchant);
      // A withdrawal the worker rejected also arrives as withdrawal.updated failed, which tells the merchant: say it once.
      const eventWillTell = args.kind === "withdrawal" && err instanceof WorkerError && err.code === "insufficient_funds";
      if (!eventWillTell) await tell(merchant, `Hmm, that didn't go through: ${reason}. Don't worry, no money moved.`);
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

    if (via !== "web" && (await isStepUp(action))) {
      await tell(merchant, "This one needs a quick extra check, so tap the withdrawal card to confirm it there.");
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
      await tell(merchant, "That one expired (confirms only last 5 minutes, to keep your money safe). Just ask me again!");
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
      const how = merchant.channel === "imessage" ? "👍 the card for the one you want" : "Tell me which one";
      await tell(merchant, `You've got ${open.length} things waiting on you: ${list}. ${how}.`);
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
