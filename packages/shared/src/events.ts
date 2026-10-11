// Events the worker and web API emit to the agent (POST {AGENT_URL}/internal/events), also appended to `events`.
// The agent turns them into messages and card updates. At-least-once delivery: dedupe on envelope.id.

import { z } from "zod";
import { MoneyZ, RecipientZ, WithdrawalStatusZ } from "./api";

export const RoveEventZ = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("payment.settled"),
    paymentId: z.string(),
    merchantId: z.string(),
    source: z.enum(["invoice", "one_time_qr", "fixed_qr"]),
    invoiceId: z.string().nullable(),
    local: MoneyZ,
    payer: RecipientZ.nullable(),
    txHash: z.string(),
    delivered: z.string(),
    firstSale: z.boolean(), // agent celebrates the merchant's first sale (confetti)
  }),
  z.object({ type: z.literal("payment.failed"), paymentId: z.string(), merchantId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("refund.completed"),
    refundId: z.string(),
    paymentId: z.string(),
    merchantId: z.string(),
    actionId: z.string(),
    amount: MoneyZ,
    payer: RecipientZ.nullable(),
  }),
  z.object({ type: z.literal("refund.failed"), refundId: z.string(), paymentId: z.string(), merchantId: z.string(), actionId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("withdrawal.updated"),
    withdrawalId: z.string(),
    merchantId: z.string(),
    status: WithdrawalStatusZ,
    amount: MoneyZ,
    sweepTxHash: z.string().optional(),
    bankRef: z.string().optional(),
    failureReason: z.string().optional(),
  }),
  z.object({ type: z.literal("merchant.live"), merchantId: z.string(), xrplAddress: z.string() }),
  z.object({ type: z.literal("shop.updated"), merchantId: z.string(), fields: z.array(z.enum(["name", "category", "currency", "menu"])) }),
  z.object({
    type: z.literal("bank_account.added"),
    merchantId: z.string(),
    bankAccountId: z.string(),
    label: z.string(), // "DBS ••••1234 (AH SENG FOOD PTE LTD)"
  }),
]);

export type RoveEvent = z.infer<typeof RoveEventZ>;

export const EventEnvelopeZ = z.object({ id: z.string(), at: z.string(), event: RoveEventZ });
export type EventEnvelope = z.infer<typeof EventEnvelopeZ>;
