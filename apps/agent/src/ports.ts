// The agent's seams. Every module takes `Deps` and talks to the outside only through these ports, so the
// same code runs against (a) the in-memory store + mock worker + console outbox (offline dev, evals) and
// (b) @rove/db + the real worker + Photon Spectrum (demo).
//
// Store mirrors the planned @rove/db surface (packages/db/src/index.ts). Methods marked [request] are not in
// that plan yet; they are listed under Requests in tasks/integration.md for Nithya.

import type {
  ActionId,
  Balance,
  BankAccount,
  CardBuilders,
  CardPresenter,
  Channel,
  Contact,
  DaySummary,
  Invoice,
  InvoiceKind,
  InvoiceLine,
  LedgerEntry,
  Links,
  MenuItem,
  Merchant,
  Money,
  Payment,
  PendingAction,
  PendingActionArgs,
  PendingActionKind,
  PendingActionStatus,
  Persona,
  Recipient,
  RoveEvent,
  EventEnvelope,
  Withdrawal,
  AgentMessage,
} from "@rove/shared";
import type { z } from "zod";
import type {
  InternalCreateMerchantReq,
  InternalCreateMerchantRes,
  InternalCreateWithdrawalReq,
  InternalCreateWithdrawalRes,
  InternalRefundReq,
  InternalRefundRes,
} from "@rove/shared";
import type { Config } from "./env";

// ------------------------------------------------------------------ data

export interface OnboardingState {
  phone: string;
  channel: Channel;
  /** start → name → category → menu → bank → done */
  step: "start" | "name" | "category" | "menu" | "bank" | "done";
  data: { name?: string; merchantId?: string; category?: string; liveRequested?: boolean };
  updatedAt: string;
}

export interface NewInvoice {
  merchantId: string;
  kind: InvoiceKind;
  contactId: string | null;
  to: Recipient | null;
  lines: InvoiceLine[];
  total: Money;
  note: string | null;
  expiresAt: string;
}

export interface Store {
  // merchants
  getMerchant(id: string): Promise<Merchant | null>;
  getMerchantByPhone(phone: string): Promise<Merchant | null>;
  /** shop code, then merchant phone, then fuzzy name. Several close names → all of them (agent asks). */
  findShop(query: string): Promise<Merchant[]>;
  upsertDraftMerchant(m: { id: string; name: string; phone: string; channel: Channel; category: string | null }): Promise<Merchant>;
  updateShop(id: string, patch: { name?: string; category?: string | null }): Promise<Merchant>;
  listLiveMerchants(): Promise<Merchant[]>; // [request]

  // menu
  listMenu(merchantId: string): Promise<MenuItem[]>; // active items, sorted
  upsertMenuItem(merchantId: string, item: { name: string; price: Money; active?: boolean }): Promise<MenuItem>;

  // contacts
  addContact(merchantId: string, c: { name: string; phone: string; channel: Channel | null }): Promise<Contact>;
  findContacts(merchantId: string, query?: string): Promise<Contact[]>;

  // invoices (kinds: invoice | one_time_qr | pay_request); code = newShortCode()
  createInvoice(i: NewInvoice): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>; // [request]
  getInvoiceByCode(code: string): Promise<Invoice | null>;
  listInvoices(merchantId: string, status: "open" | "paid" | "all"): Promise<Invoice[]>;
  openInvoicesForPhone(phone: string): Promise<Invoice[]>;
  cancelInvoice(code: string): Promise<boolean>;
  invoicesDueForReminder(createdBefore: string): Promise<Invoice[]>; // [request] open, kind=invoice, reminded_at null
  markInvoiceReminded(id: string): Promise<boolean>; // [request] CAS on reminded_at null

  // payments + ledger
  getPayment(id: string): Promise<Payment | null>;
  listPayments(merchantId: string, limit: number): Promise<Payment[]>;
  receiptsForPhone(phone: string, limit: number): Promise<(Payment & { merchantName: string })[]>;
  daySummary(merchantId: string, date: string): Promise<DaySummary>; // date = YYYY-MM-DD Asia/Singapore
  getBalance(merchantId: string): Promise<Balance>;

  // bank + withdrawals
  getDefaultBankAccount(merchantId: string): Promise<BankAccount | null>;
  getWithdrawal(id: string): Promise<Withdrawal | null>;

  // pending actions
  insertAction(a: { merchantId: string; kind: PendingActionKind; args: PendingActionArgs; expiresAt: string }): Promise<PendingAction>;
  getAction(id: ActionId): Promise<PendingAction | null>;
  setActionMessageIds(id: ActionId, messageIds: string[]): Promise<void>; // [request]
  findActionByMessageId(messageId: string): Promise<PendingAction | null>; // [request] any status
  findOpenActionsForMerchant(merchantId: string): Promise<PendingAction[]>;
  /** UPDATE … SET status='executing' WHERE id=$1 AND status='proposed' AND expires_at > now(). */
  claimAction(id: ActionId): Promise<boolean>;
  finishAction(id: ActionId, status: Extract<PendingActionStatus, "done" | "failed" | "cancelled">, result?: unknown): Promise<void>; // [request]
  /** proposed + past expiry → expired; returns the ones it changed. */
  expireActions(): Promise<PendingAction[]>; // [request]
  /** The open action (any status) attached to a withdrawal / refund, for event handlers. */
  findActionByRef(ref: string): Promise<PendingAction | null>; // [request] args.withdrawalId or args.paymentId

  // agent memory + onboarding
  appendAgentMessage(m: Omit<AgentMessage, "createdAt">): Promise<void>;
  recentAgentMessages(phone: string, limit: number): Promise<AgentMessage[]>; // oldest first
  getOnboarding(phone: string): Promise<OnboardingState | null>;
  setOnboarding(phone: string, channel: Channel, step: OnboardingState["step"], data: OnboardingState["data"]): Promise<OnboardingState>;

  // plumbing
  /** insert into processed(key); false if seen. */
  claim(key: string): Promise<boolean>;

  // offline-only helpers (memory store) used by the mock worker; absent on the real store
  readonly mock?: MockStoreHooks;
}

/** What the mock worker needs to simulate the real worker against the in-memory store. */
export interface MockStoreHooks {
  setMerchantLive(id: string, xrplAddress: string): Promise<void>;
  appendLedger(e: Omit<LedgerEntry, "id" | "createdAt">): Promise<void>;
  insertWithdrawal(w: Withdrawal): Promise<void>;
  updateWithdrawal(id: string, patch: Partial<Withdrawal>): Promise<Withdrawal>;
  updatePayment(id: string, patch: Partial<Payment>): Promise<Payment>;
  setAutoWithdraw(id: string, mode: "off" | "daily"): Promise<void>;
  addBankAccount(b: Omit<BankAccount, "id" | "createdAt">): Promise<BankAccount>;
  /** Simulate a customer paying an invoice (evals / terminal "/pay K7Q2MX"). Returns the payment. */
  payInvoice(code: string, payer: Recipient | null): Promise<Payment>;
}

// ------------------------------------------------------------------ worker (Nithya's internal routes)

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WorkerClient {
  createWithdrawal(req: z.infer<typeof InternalCreateWithdrawalReq>): Promise<z.infer<typeof InternalCreateWithdrawalRes>>;
  executeWithdrawal(withdrawalId: string, actionId: string): Promise<void>;
  refund(req: z.infer<typeof InternalRefundReq>): Promise<z.infer<typeof InternalRefundRes>>;
  createMerchant(req: z.infer<typeof InternalCreateMerchantReq>): Promise<z.infer<typeof InternalCreateMerchantRes>>;
  setAutoWithdraw(merchantId: string, mode: "off" | "daily"): Promise<void>;
}

// ------------------------------------------------------------------ outbound messaging

export type ScreenEffect = "confetti" | "balloons" | "fireworks";

/** Everything the agent sends. Cards go through Sahith's CardPresenter; the rest is channel-native here. */
export interface Outbox {
  cards: CardPresenter;
  text(to: Recipient, body: string): Promise<{ messageId: string }>;
  image(to: Recipient, png: Uint8Array, name: string, caption?: string): Promise<{ messageId: string }>;
  /** iMessage poll. Votes come back as poll_option (or a digit reply). */
  poll(to: Recipient, title: string, options: string[]): Promise<{ messageId: string }>;
  /** iMessage screen effect. */
  effect(to: Recipient, body: string, effect: ScreenEffect): Promise<{ messageId: string }>;
  /** Voice note (m4a/AAC). Platforms without voice notes get an audio attachment. */
  voice(to: Recipient, audio: Buffer, opts: { name: string; mimeType: string; duration?: number }): Promise<{ messageId: string }>;
  /** Rove's own contact card ("save me"), as an iMessage nativeContactCard. */
  contactCard(to: Recipient): Promise<void>;
  /** Which channel reaches this phone. Always iMessage: WhatsApp was dropped. */
  resolveChannel(phone: string): Promise<Channel>;
}

/** QR images (Sahith, SH-B6). Null when not built yet → the agent sends the link as text instead. */
export interface QrImages {
  qrPng(url: string): Promise<Uint8Array | null>;
  stickerPng(v: { name: string; url: string; verified: boolean; shopCode: string }): Promise<Uint8Array | null>;
}

// ------------------------------------------------------------------ inbound

/** One normalized inbound message (runtime.ts maps Spectrum content to this). */
export type Inbound =
  | { type: "text"; text: string }
  | { type: "voice"; audio: Buffer; mimeType: string }
  | { type: "reaction"; emoji: string; targetMessageId: string }
  | { type: "poll_option"; title: string; pollTitle: string; selected: boolean }
  | { type: "contact"; name: string | null; phones: string[]; note: string | null }
  | { type: "other"; kind: string };

/** How the reply to the current inbound message is delivered (the runtime binds it to the Spectrum space). */
export interface ReplyChannel {
  text(body: string): Promise<{ messageId: string }>;
  /** Typing indicator while fn runs. */
  responding<T>(fn: () => Promise<T>): Promise<T>;
}

// ------------------------------------------------------------------ modules (each built by a factory from Deps)

export type AgentPersona = Persona | "onboarding";

export interface TurnInput {
  persona: Persona;
  from: Recipient;
  merchant: Merchant | null;
  text: string;
  /** The message arrived as a voice note (reply by voice too). */
  voice: boolean;
}
export interface TurnResult {
  reply: string;
  /** Tool names called this turn, in order (evals assert on these). */
  toolCalls: { name: string; input: unknown; result: string }[];
  refused: boolean;
}

export interface TurnRunner {
  turn(input: TurnInput): Promise<TurnResult>;
}

export interface ActionsService {
  /** Create the pending action, send the confirm card / ask, record the message ids a 👍 can target. */
  propose(merchant: Merchant, kind: PendingActionKind, args: PendingActionArgs, summary: string): Promise<PendingAction>;
  confirm(actionId: string, via: "tapback" | "reply" | "card" | "web"): Promise<{ action: PendingAction; summary: string; outcome: "executing" | "done" | "expired" | "already" | "failed" | "not_found" }>;
  /** 👍 on a message: confirms the action that message belongs to. False if the message isn't a confirm. */
  confirmByMessageId(messageId: string, by: Recipient): Promise<boolean>;
  /** YES reply: the merchant's single open action. False if none (so the text goes to Claude). */
  confirmLatest(merchant: Merchant, from: Recipient): Promise<boolean>;
  /** Events: withdrawal finished / refund finished → mark done, edit the confirm card. */
  settle(ref: string, status: "done" | "failed", result?: unknown): Promise<void>;
  /** Expire overdue actions and edit their cards to "Expired". Called every 30s. */
  sweep(): Promise<void>;
  /** Summary line for an action, e.g. "Withdraw S$50.00 to DBS ••••1234". */
  summarize(action: PendingAction): Promise<string>;
}

export interface OnboardingFlow {
  /** Begin onboarding for this phone (first "hi", or start_shop). */
  start(from: Recipient): Promise<void>;
  /** Free text while onboarding. */
  handle(from: Recipient, text: string): Promise<void>;
  /** iMessage poll vote. */
  vote(from: Recipient, option: string): Promise<void>;
  /** Events relevant to a merchant still onboarding (shop.updated, merchant.live, bank_account.added). True if handled. */
  onEvent(event: RoveEvent): Promise<boolean>;
}

export interface Voice {
  /** Speech → text (ElevenLabs STT, ffmpeg conversion if needed). */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
  /** Text → m4a voice note bytes (ElevenLabs TTS → ffmpeg AAC). Null if voice is not configured. */
  speak(text: string): Promise<{ audio: Buffer; mimeType: string; name: string; duration?: number } | null>;
}

export interface EventsHandler {
  handle(envelope: EventEnvelope): Promise<"handled" | "duplicate">;
}

// ------------------------------------------------------------------ dependency bag

export interface Deps {
  config: Config;
  store: Store;
  worker: WorkerClient;
  outbox: Outbox;
  builders: CardBuilders;
  links: Links;
  qr: QrImages;
  log: (...args: unknown[]) => void;
  now: () => Date;
  /** Signed merchant page session token (tokens.ts). */
  sessionToken(merchantId: string, scope: "setup" | "bank" | "shop" | "withdrawal" | "sale", ref?: string): string;
  /** Signed confirm-button token for a pending action. */
  confirmToken(actionId: string, merchantId: string): string;
}
