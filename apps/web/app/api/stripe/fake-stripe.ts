// In-memory Stripe for route tests (NI-B2, NI-B3). Owner: Nithya. Test-only: never imported by a route.
//
//   const fake = createFakeStripe();
//   const deps = await useWebTestDeps({ stripe: fake.client, config: { ...TEST_WEB_CONFIG, stripeWebhookSecret: FAKE_WEBHOOK_SECRET } });
//   fake.succeed(piId, "apple_pay");                       // the payer paid
//   const { payload, header } = fake.signedEvent("payment_intent.succeeded", fake.intent(piId));
//
// Only what the routes call: paymentIntents.create / retrieve / cancel, refunds.create, and the real SDK's `webhooks`
// (constructEvent + generateTestHeaderString work offline), so signatures are checked exactly like production.

import Stripe from "stripe";

export const FAKE_WEBHOOK_SECRET = "whsec_fake_test_secret";

export interface FakeIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: null | { code?: string; decline_code?: string };
}

export interface FakeRefund {
  id: string;
  object: "refund";
  payment_intent: string;
  amount: number;
  status: "succeeded";
}

type Options = { idempotencyKey?: string } | undefined;

/** Shaped like the SDK's errors (route code duck-types on `type` + `code`). */
export function stripeError(type: string, code: string, message = code): Error {
  return Object.assign(new Error(message), { type, code, statusCode: 400 });
}

export function createFakeStripe() {
  const intents = new Map<string, FakeIntent>();
  const refunds = new Map<string, FakeRefund>(); // idempotency key → refund
  const wallets = new Map<string, string | null>(); // pi id → wallet type on its charge
  const calls = {
    create: [] as { params: Stripe.PaymentIntentCreateParams; options: Options }[],
    retrieve: [] as { id: string; params?: Stripe.PaymentIntentRetrieveParams }[],
    cancel: [] as string[],
    refund: [] as { params: Stripe.RefundCreateParams; options: Options }[],
  };
  /** Set to make the next call of that kind throw (then it resets). */
  const failNext: { create?: Error; retrieve?: Error; refund?: Error } = {};
  const byKey = new Map<string, string>(); // idempotency key → pi id
  let n = 0;
  const sdk = new Stripe("sk_test_fake_offline_only"); // for `webhooks` only; never makes a request

  const getIntent = (id: string): FakeIntent => {
    const pi = intents.get(id);
    if (!pi) throw stripeError("StripeInvalidRequestError", "resource_missing", `No such payment_intent: '${id}'`);
    return pi;
  };
  const take = (k: keyof typeof failNext) => {
    const err = failNext[k];
    delete failNext[k];
    if (err) throw err;
  };

  const paymentIntents = {
    async create(params: Stripe.PaymentIntentCreateParams, options?: Options): Promise<FakeIntent> {
      calls.create.push({ params, options });
      take("create");
      const existing = options?.idempotencyKey ? byKey.get(options.idempotencyKey) : undefined;
      if (existing) return { ...getIntent(existing) };
      const id = `pi_fake${String(++n).padStart(4, "0")}`;
      const pi: FakeIntent = {
        id,
        object: "payment_intent",
        amount: params.amount,
        amount_received: 0,
        currency: params.currency,
        status: "requires_payment_method",
        client_secret: `${id}_secret_${n}`,
        metadata: { ...(params.metadata as Record<string, string>) },
        latest_charge: null,
        last_payment_error: null,
      };
      intents.set(id, pi);
      if (options?.idempotencyKey) byKey.set(options.idempotencyKey, id);
      return { ...pi };
    },
    async retrieve(id: string, params?: Stripe.PaymentIntentRetrieveParams) {
      calls.retrieve.push({ id, params });
      take("retrieve");
      const pi = getIntent(id);
      if (!params?.expand?.includes("latest_charge") || !pi.latest_charge) return { ...pi };
      const wallet = wallets.get(id) ?? null;
      return {
        ...pi,
        latest_charge: {
          id: pi.latest_charge,
          object: "charge",
          payment_method_details: { type: "card", card: { brand: "visa", wallet: wallet ? { type: wallet } : null } },
        },
      };
    },
    async cancel(id: string) {
      calls.cancel.push(id);
      const pi = getIntent(id);
      if (pi.status === "succeeded" || pi.status === "canceled") {
        throw stripeError("StripeInvalidRequestError", "payment_intent_unexpected_state", `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`);
      }
      pi.status = "canceled";
      return { ...pi };
    },
  };

  const refundsApi = {
    async create(params: Stripe.RefundCreateParams, options?: Options): Promise<FakeRefund> {
      calls.refund.push({ params, options });
      take("refund");
      const key = options?.idempotencyKey ?? `auto_${refunds.size}`;
      const existing = refunds.get(key);
      if (existing) return existing;
      const pi = getIntent(String(params.payment_intent));
      const refund: FakeRefund = { id: `re_fake${refunds.size + 1}`, object: "refund", payment_intent: pi.id, amount: params.amount ?? pi.amount_received, status: "succeeded" };
      refunds.set(key, refund);
      return refund;
    },
  };

  const client = { paymentIntents, refunds: refundsApi, webhooks: sdk.webhooks } as unknown as Stripe;

  return {
    client,
    intents,
    refunds,
    calls,
    failNext,
    intent: (id: string): FakeIntent => ({ ...getIntent(id) }),
    /** The payer completed payment: status succeeded, a charge with this wallet (null = plain card). */
    succeed(id: string, wallet: "apple_pay" | "google_pay" | null = null): FakeIntent {
      const pi = getIntent(id);
      pi.status = "succeeded";
      pi.amount_received = pi.amount;
      pi.latest_charge = `ch_${id.slice(3)}`;
      wallets.set(id, wallet);
      return { ...pi };
    },
    /** A Stripe event body for `object`, plus a valid Stripe-Signature header for it. */
    signedEvent(type: string, object: object, eventId = `evt_fake${String(++n).padStart(4, "0")}`, secret = FAKE_WEBHOOK_SECRET) {
      const payload = JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "2025-02-24.acacia",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type,
        data: { object },
      });
      return { eventId, payload, header: sdk.webhooks.generateTestHeaderString({ payload, secret }) };
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
