// Worker client. Owner: Saran (caller side of Nithya's internal routes, docs/02 "Internal").
//  - createHttpWorker: the real worker over HTTP (Bearer INTERNAL_SECRET), responses validated with the shared zod schemas.
//  - createMockWorker: offline stand-in against the in-memory store (store.mock). Emits the same events the real
//    worker would (withdrawal.updated per step, refund.completed, merchant.live) back into the agent.

import { randomInt } from "node:crypto";
import {
  add,
  cmp,
  format,
  InternalCreateMerchantRes,
  InternalCreateWithdrawalRes,
  InternalRefundRes,
  internalHeaders,
  money,
  newId,
  ROUTES,
  sub,
  toMinor,
  WITHDRAWAL_LIMITS,
  zero,
  type BankAccount,
  type EventEnvelope,
  type Money,
  type RoveEvent,
  type Withdrawal,
  type WithdrawalStatus,
} from "@rove/shared";
import type { z } from "zod";
import type { Config } from "./env";
import { WorkerError, type Store, type WorkerClient } from "./ports";

// ------------------------------------------------------------------ real worker

export function createHttpWorker(config: Config): WorkerClient {
  const base = config.workerUrl.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers: internalHeaders(config.internalSecret), body: JSON.stringify(body) });
    } catch (err) {
      throw new WorkerError(`worker unreachable at ${base}: ${(err as Error).message}`, 503);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error ?? (text || res.statusText);
      throw new WorkerError(msg, res.status);
    }
    return schema ? schema.parse(json) : (json as T);
  }

  return {
    createWithdrawal: (req) => call("POST", ROUTES.worker.withdrawals, req, InternalCreateWithdrawalRes),
    executeWithdrawal: async (id, actionId) => {
      await call("POST", ROUTES.worker.executeWithdrawal(id), { actionId });
    },
    refund: (req) => call("POST", ROUTES.worker.refunds, req, InternalRefundRes),
    createMerchant: (req) => call("POST", ROUTES.worker.merchants, req, InternalCreateMerchantRes),
    setAutoWithdraw: async (merchantId, mode) => {
      await call("PATCH", ROUTES.worker.autoWithdraw(merchantId), { mode });
    },
  };
}

// ------------------------------------------------------------------ mock worker

function bankLabel(b: BankAccount): string {
  return `${b.bankName ?? "PayNow"} ••••${b.last4}`;
}
function walletLabel(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-3)}`;
}

export function createMockWorker(
  store: Store,
  emit: (e: EventEnvelope) => Promise<unknown>,
  opts: { stepDelayMs?: number } = {},
): WorkerClient {
  const hooks = store.mock;
  if (!hooks) throw new Error("createMockWorker needs the in-memory store (store.mock)");
  const delay = opts.stepDelayMs ?? 1500;
  const labels = new Map<string, string>(); // withdrawalId → destination label
  const refundsByAction = new Map<string, { refundId: string; status: "completed" }>();
  const executing = new Set<string>();

  const send = (event: RoveEvent) => emit({ id: newId("evt"), at: new Date().toISOString(), event });
  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  const view = (w: Withdrawal): z.infer<typeof InternalCreateWithdrawalRes> => ({
    id: w.id,
    amount: w.amount,
    fee: w.fee,
    destination: { kind: w.destination.kind, label: labels.get(w.id) ?? "" },
    status: w.status,
    ...(w.sweepTxHash ? { sweepTxHash: w.sweepTxHash } : {}),
    ...(w.bankRef ? { bankRef: w.bankRef } : {}),
    ...(w.failureReason ? { failureReason: w.failureReason } : {}),
    needsStepUp: w.needsStepUp,
    updatedAt: w.updatedAt,
  });

  async function step(w: Withdrawal, status: WithdrawalStatus, patch: Partial<Withdrawal> = {}): Promise<Withdrawal> {
    await sleep(delay);
    const next = await hooks!.updateWithdrawal(w.id, { ...patch, status });
    await send({
      type: "withdrawal.updated",
      withdrawalId: next.id,
      merchantId: next.merchantId,
      status: next.status,
      amount: next.amount,
      ...(next.sweepTxHash ? { sweepTxHash: next.sweepTxHash } : {}),
      ...(next.bankRef ? { bankRef: next.bankRef } : {}),
      ...(next.failureReason ? { failureReason: next.failureReason } : {}),
    });
    return next;
  }

  async function runPipeline(w: Withdrawal): Promise<void> {
    let cur = await step(w, "approved");
    cur = await step(cur, "onchain_pending");
    const sweepTxHash = randomHex(64);
    cur = await step(cur, "onchain_settled", { sweepTxHash });
    await hooks!.appendLedger({ merchantId: cur.merchantId, kind: "withdrawal_debit", amount: cur.amount, ref: cur.id });
    if (cur.destination.kind === "xrpl_wallet") {
      await step(cur, "completed");
      return;
    }
    cur = await step(cur, "payout_pending", { partnerPayoutId: `sx_po_${randomInt(1e9)}` });
    await step(cur, "completed", { bankRef: `FAST-${String(randomInt(1e6)).padStart(6, "0")}` });
  }

  return {
    async createWithdrawal(req) {
      const merchant = await store.getMerchant(req.merchantId);
      if (!merchant) throw new WorkerError(`Unknown shop ${req.merchantId}`, 404);
      const balance = await store.getBalance(merchant.id);
      const c = merchant.currency;
      const amount: Money = req.amount === null ? balance.available : money(req.amount, c);
      const min = money(WITHDRAWAL_LIMITS.minSgd, c);
      if (cmp(amount, min) < 0) {
        throw new WorkerError(
          req.amount === null
            ? `Nothing to withdraw yet: available balance is ${format(balance.available)}.`
            : `The minimum withdrawal is ${format(min)}.`,
          422,
        );
      }
      if (cmp(amount, balance.available) > 0) {
        throw new WorkerError(`That's more than your available balance of ${format(balance.available)}.`, 422);
      }

      let destination: Withdrawal["destination"];
      let label: string;
      if (req.destination?.kind === "xrpl_wallet") {
        destination = { kind: "xrpl_wallet", address: req.destination.address };
        label = walletLabel(req.destination.address);
      } else {
        const bank = await store.getDefaultBankAccount(merchant.id);
        if (!bank) throw new WorkerError("No bank account yet", 409);
        destination = { kind: "bank", bankAccountId: req.destination?.kind === "bank" ? req.destination.bankAccountId : bank.id };
        label = bankLabel(bank);
      }

      const at = new Date().toISOString();
      const w: Withdrawal = {
        id: newId("wd"),
        merchantId: merchant.id,
        amount,
        fee: zero(c),
        destination,
        status: "requested",
        needsStepUp: toMinor(amount) > toMinor(money(WITHDRAWAL_LIMITS.stepUpAboveSgd, c)),
        createdAt: at,
        updatedAt: at,
      };
      labels.set(w.id, label);
      await hooks.insertWithdrawal(w);
      return view(w);
    },

    async executeWithdrawal(withdrawalId, _actionId) {
      const w = await store.getWithdrawal(withdrawalId);
      if (!w) throw new WorkerError(`Unknown withdrawal ${withdrawalId}`, 404);
      if (w.status !== "requested" || executing.has(w.id)) return; // idempotent on withdrawal id
      const balance = await store.getBalance(w.merchantId);
      if (cmp(w.amount, balance.available) > 0) {
        await hooks.updateWithdrawal(w.id, { status: "failed", failureReason: "Balance changed since the request" });
        await send({ type: "withdrawal.updated", withdrawalId: w.id, merchantId: w.merchantId, status: "failed", amount: w.amount, failureReason: "Balance changed since the request" });
        return;
      }
      executing.add(w.id);
      await hooks.appendLedger({ merchantId: w.merchantId, kind: "withdrawal_hold", amount: w.amount, ref: w.id });
      const run = runPipeline(w).catch((err) => console.error("[mock-worker] withdrawal pipeline", err));
      if (delay === 0) await run; // evals: deterministic, everything done when the call returns
    },

    async refund(req) {
      const done = refundsByAction.get(req.actionId);
      if (done) return done;
      const p = await store.getPayment(req.paymentId);
      if (!p) throw new WorkerError(`Unknown payment ${req.paymentId}`, 404);
      if (p.status !== "settled" && p.status !== "partially_refunded") throw new WorkerError(`That payment can't be refunded (it's ${p.status}).`, 422);
      const amount = money(req.amount, p.local.currency);
      const left = sub(p.local, p.refunded);
      if (toMinor(amount) <= 0n || cmp(amount, left) > 0) throw new WorkerError(`You can refund at most ${format(left)} on that payment.`, 422);
      const balance = await store.getBalance(p.merchantId);
      if (cmp(amount, balance.available) > 0) throw new WorkerError(`Not enough available balance (${format(balance.available)}) to refund ${format(amount)}.`, 422);

      const refundId = newId("ref");
      await hooks.appendLedger({ merchantId: p.merchantId, kind: "refund_debit", amount, ref: refundId });
      const total = add(p.refunded, amount);
      await hooks.updatePayment(p.id, { refunded: total, status: cmp(total, p.local) === 0 ? "refunded" : "partially_refunded" });
      const res = { refundId, status: "completed" as const };
      refundsByAction.set(req.actionId, res);
      await send({ type: "refund.completed", refundId, paymentId: p.id, merchantId: p.merchantId, actionId: req.actionId, amount, payer: p.payer });
      return res;
    },

    async createMerchant(req) {
      const m = await store.getMerchant(req.id);
      if (!m) throw new WorkerError(`Unknown shop ${req.id}`, 404);
      const xrplAddress = m.xrplAddress ?? `r${randomBase58(33)}`;
      if (m.status !== "live") {
        await hooks.setMerchantLive(m.id, xrplAddress);
        await send({ type: "merchant.live", merchantId: m.id, xrplAddress });
      }
      return { merchantId: m.id, xrplAddress, credentialStatus: "accepted" as const };
    },

    async setAutoWithdraw(merchantId, mode) {
      await hooks.setAutoWithdraw(merchantId, mode);
    },
  };
}

function randomHex(len: number): string {
  let s = "";
  while (s.length < len) s += randomInt(16).toString(16);
  return s.toUpperCase();
}

function randomBase58(len: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}
