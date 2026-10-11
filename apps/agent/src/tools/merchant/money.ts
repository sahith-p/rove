// Merchant tools for money: reporting, and the propose_* tools. Nothing here moves money: propose_* create a
// pending action (ctx.actions.propose) that only a human confirmation executes.

import { add, cmp, format, MerchantToolInputs, sub, zero, type DaySummary } from "@rove/shared";
import { defineTool, ToolError } from "../../agent/tool";
import { WorkerError } from "../../ports";
import type { ToolContext } from "../context";
import { localDate } from "../../time";
import { describeLines, parseAmount } from "../pricing";
import { personLabel, requireMerchant } from "./util";

const DAY_MS = 24 * 3600 * 1000;

export function moneyTools(ctx: ToolContext) {
  const { deps, calls, actions } = ctx;
  const merchant = requireMerchant(ctx);
  const { store, worker } = deps;
  const howToConfirm = () => (merchant.channel === "imessage" ? "👍 the confirm card" : "reply YES");

  const summaryText = (label: string, s: Pick<DaySummary, "count" | "gross" | "refunded" | "net" | "openInvoices">) =>
    `${label}: ${s.count} sale${s.count === 1 ? "" : "s"}, gross ${format(s.gross)}, refunded ${format(s.refunded)}, net ${format(s.net)}. Open invoices: ${s.openInvoices}.`;

  return [
    defineTool(
      "get_sales",
      "Sales totals for today, yesterday, or the last 7 days (the shop's local time).",
      MerchantToolInputs.get_sales,
      async ({ range }) => {
        const now = deps.now().getTime();
        if (range !== "7d") {
          const date = localDate(new Date(range === "today" ? now : now - DAY_MS));
          return summaryText(`${range === "today" ? "Today" : "Yesterday"} (${date})`, await store.daySummary(merchant.id, date));
        }
        const days = await Promise.all(Array.from({ length: 7 }, (_, i) => store.daySummary(merchant.id, localDate(new Date(now - i * DAY_MS)))));
        const c = merchant.currency;
        const total = days.reduce(
          (acc, d) => ({ count: acc.count + d.count, gross: add(acc.gross, d.gross), refunded: add(acc.refunded, d.refunded), net: add(acc.net, d.net) }),
          { count: 0, gross: zero(c), refunded: zero(c), net: zero(c) },
        );
        return summaryText("Last 7 days", { ...total, openInvoices: days[0]?.openInvoices ?? 0 });
      },
      calls,
    ),
    defineTool(
      "list_payments",
      "Recent payments with ids, payer, amount and status. Use the payment id for refunds.",
      MerchantToolInputs.list_payments,
      async ({ limit }) => {
        const [payments, contacts] = await Promise.all([store.listPayments(merchant.id, limit), store.findContacts(merchant.id)]);
        if (!payments.length) return "No payments yet.";
        return payments
          .map((p) => {
            const refunded = cmp(p.refunded, zero(p.refunded.currency)) > 0 ? ` (refunded ${format(p.refunded)})` : "";
            const items = p.lines.length ? ` · ${describeLines(p.lines)}` : "";
            return `${p.id} · ${format(p.local)}${refunded} from ${personLabel(p.payer?.phone, contacts)} · ${p.status} · ${p.method} · ${p.createdAt}${items}`;
          })
          .join("\n");
      },
      calls,
    ),
    defineTool(
      "get_balance",
      "The shop's balance: available, held for in-flight withdrawals, and total.",
      MerchantToolInputs.get_balance,
      async () => {
        const b = await store.getBalance(merchant.id);
        return `Available ${format(b.available)} · held ${format(b.held)} · total ${format(b.total)}`;
      },
      calls,
    ),
    defineTool(
      "propose_withdrawal",
      "Propose withdrawing to the merchant's bank (default) or their own XRPL wallet. Omit amount for everything available. This only proposes: the merchant must confirm before any money moves.",
      MerchantToolInputs.propose_withdrawal,
      async ({ amount, to, walletAddress }) => {
        if (to === "wallet" && !walletAddress) throw new ToolError("Which XRPL wallet address should it go to?");
        if (amount !== undefined) {
          const m = parseAmount(amount, merchant.currency);
          if (!m || m.amount === "0.00") throw new ToolError(`"${amount}" isn't a valid amount.`);
        }
        let view;
        try {
          view = await worker.createWithdrawal({
            merchantId: merchant.id,
            amount: amount ?? null,
            destination: to === "wallet" && walletAddress ? { kind: "xrpl_wallet", address: walletAddress } : null,
          });
        } catch (err) {
          if (err instanceof WorkerError) throw new ToolError(err.message);
          throw err;
        }
        const summary = `Withdraw ${format(view.amount)} to ${view.destination.label}`;
        await actions.propose(merchant, "withdrawal", { kind: "withdrawal", withdrawalId: view.id }, summary);
        return JSON.stringify({
          status: "awaiting_confirmation",
          summary,
          fee: format(view.fee),
          needsStepUp: view.needsStepUp,
          how: view.needsStepUp ? "confirm on the withdrawal page" : howToConfirm(),
        });
      },
      calls,
    ),
    defineTool(
      "set_auto_withdraw",
      "Propose turning nightly auto-withdraw to the bank on (daily) or off. Needs the merchant's confirmation.",
      MerchantToolInputs.set_auto_withdraw,
      async ({ mode }) => {
        if (merchant.autoWithdraw === mode) return `Auto-withdraw is already ${mode}.`;
        const summary = mode === "daily" ? "Turn on daily auto-withdraw to your bank" : "Turn off auto-withdraw";
        await actions.propose(merchant, "set_auto_withdraw", { kind: "set_auto_withdraw", mode }, summary);
        return JSON.stringify({ status: "awaiting_confirmation", summary, how: howToConfirm() });
      },
      calls,
    ),
    defineTool(
      "propose_refund",
      "Propose refunding a payment (full by default, or a partial amount). Get the payment id from list_payments. Needs the merchant's confirmation.",
      MerchantToolInputs.propose_refund,
      async ({ paymentId, amount, reason }) => {
        const p = await store.getPayment(paymentId.trim());
        if (!p || p.merchantId !== merchant.id) throw new ToolError(`No payment ${paymentId}. Use list_payments to find it.`);
        if (p.status !== "settled" && p.status !== "partially_refunded") throw new ToolError(`That payment is ${p.status}, so it can't be refunded.`);
        const refundable = sub(p.local, p.refunded);
        const amt = amount !== undefined ? parseAmount(amount, p.local.currency) : refundable;
        if (!amt || amt.amount === "0.00") throw new ToolError(`"${amount}" isn't a valid amount.`);
        if (cmp(amt, refundable) > 0) throw new ToolError(`Only ${format(refundable)} of that payment can still be refunded.`);
        const balance = await store.getBalance(merchant.id);
        if (cmp(amt, balance.available) > 0) throw new ToolError(`Available balance is ${format(balance.available)}, not enough to refund ${format(amt)}.`);
        const contacts = await store.findContacts(merchant.id);
        const who = p.payer ? (contacts.find((c) => c.phone === p.payer!.phone)?.name ?? p.payer.phone) : "the customer";
        const summary = `Refund ${format(amt)} to ${who}`;
        await actions.propose(merchant, "refund", { kind: "refund", paymentId: p.id, amount: amt, reason }, summary);
        return JSON.stringify({ status: "awaiting_confirmation", summary, how: howToConfirm() });
      },
      calls,
    ),
  ];
}
