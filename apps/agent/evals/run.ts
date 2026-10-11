// Agent evals (SA-B4). In-process harness: no Spectrum. Each case gets a fresh agent on the memory store +
// mock worker + recording outbox, replays its turns through the production router (src/inbound.ts), and
// checks tool calls, replies, outbound sends and worker calls.
//
//   pnpm --filter agent evals                 all cases
//   pnpm --filter agent evals --only <id>     one case (repeatable)
//   pnpm --filter agent evals --repeat 3      run each selected case 3 times, report per-case pass rate
//   pnpm --filter agent evals --concurrency 4 run up to 4 cases at once (default 1)
//
// Every reply in every case must also pass the global reply checks (globalReplyProblems): no markdown, no leaked
// internal markup, no raw ids (inv_…, pay_…) unless the case sets allowIds, at most 400 characters.
//
// Without ANTHROPIC_API_KEY only the cases that never reach Claude run (fast paths, onboarding, confirms);
// the rest print SKIP.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Imported after .env is loaded: env.ts reads process.env at module load.
const { money } = await import("@rove/shared");
const { DEMO_CUSTOMER, DEMO_MERCHANT } = await import("@rove/shared/mocks");
const { buildAgent } = await import("../src/app");
const { config } = await import("../src/env");
const { handleInbound } = await import("../src/inbound");
const { createConsoleOutbox } = await import("../src/outbox");
type RecordedSend = import("../src/outbox").RecordedSend;
type Inbound = import("../src/ports").Inbound;
type ReplyChannel = import("../src/ports").ReplyChannel;
type TurnResult = import("../src/ports").TurnResult;
type Recipient = import("@rove/shared").Recipient;

// ------------------------------------------------------------------ case format

const InboundCase = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("voice"), transcript: z.string() }),
  /** 👍 (default) on a message. "$lastConfirm" = the most recent confirm / withdrawal card or "👍 to …" text. */
  z.object({ type: z.literal("reaction"), emoji: z.string().default("👍"), target: z.string().default("$lastConfirm") }),
  z.object({ type: z.literal("contact"), name: z.string().nullable(), phones: z.array(z.string()), note: z.string().nullable().default(null) }),
  z.object({ type: z.literal("poll_option"), title: z.string(), pollTitle: z.string().default(""), selected: z.boolean().default(true) }),
  /** The /w step-up page or a confirm-card button: confirms the merchant's latest open action. */
  z.object({ type: z.literal("web_confirm"), via: z.enum(["card", "web"]).default("web") }),
]);

const CaseZ = z.object({
  id: z.string(),
  description: z.string(),
  as: z.enum(["merchant", "customer", "stranger"]),
  /** Set false for cases that never reach Claude (they also run without ANTHROPIC_API_KEY). */
  needsClaude: z.boolean().optional(),
  /** Fixed clock for the whole case (ISO), e.g. to check greetings at a given local time. */
  now: z.string().optional(),
  /** Replies may mention raw ids (inv_…, pay_…, act_…) without failing the global check. */
  allowIds: z.boolean().optional(),
  setup: z
    .object({
      addBank: z.boolean().optional(),
      /** One-time code for the demo shop → $code */
      createCode: z.object({ amount: z.string(), expired: z.boolean().optional() }).optional(),
      /** Open invoice from the demo shop to the demo customer → $invoiceCode */
      invoiceCustomer: z.object({ amount: z.string() }).optional(),
      /** An invoice to the demo customer, paid (settled) → $paymentId, $paidCode */
      payInvoice: z.object({ amount: z.string() }).optional(),
    })
    .optional(),
  turns: z.array(z.object({ inbound: InboundCase })).min(1),
  expect: z.object({
    tools: z.array(z.string()).optional(),
    notTools: z.array(z.string()).optional(),
    toolInput: z.array(z.object({ tool: z.string(), match: z.record(z.unknown()) })).optional(),
    /** Over the replies in the sender's thread (reply channel). */
    replyMatches: z.array(z.string()).optional(),
    replyNotMatches: z.array(z.string()).optional(),
    /** Over every reply + every outbound send body (cards, texts, captions). */
    textMatches: z.array(z.string()).optional(),
    textNotMatches: z.array(z.string()).optional(),
    sends: z.array(z.object({ kind: z.string(), contains: z.string().optional(), to: z.enum(["merchant", "customer", "sender"]).optional() })).optional(),
    noSends: z.array(z.string()).optional(),
    claudeCalled: z.boolean().optional(),
    workerCalls: z.array(z.object({ method: z.string(), count: z.number().int() })).optional(),
  }),
});
type Case = z.infer<typeof CaseZ>;

// ------------------------------------------------------------------ helpers

const STRANGER: Recipient = { phone: "+6590009999", channel: "imessage" };
const MERCHANT: Recipient = { phone: DEMO_MERCHANT.phone, channel: DEMO_MERCHANT.channel };
const CUSTOMER: Recipient = { phone: DEMO_CUSTOMER.phone, channel: DEMO_CUSTOMER.channel };

/** Recorded kinds are owned by outbox.ts; match "invoice" against "invoice", "card:invoice", "card_invoice", … */
function kindMatches(recorded: string, wanted: string): boolean {
  const r = recorded.toLowerCase();
  const w = wanted.toLowerCase();
  return r === w || r.endsWith(`:${w}`) || r.endsWith(`_${w}`) || r.endsWith(`.${w}`) || r.startsWith(`${w}:`);
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "string" && typeof actual === "string") return actual.toLowerCase() === expected.toLowerCase();
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((e) => actual.some((a) => partialMatch(a, e)));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => partialMatch((actual as Record<string, unknown>)[k], v));
}

const re = (s: string) => new RegExp(s, "i");

/** Checks every reply must pass: it's a text message from a person, not a system dump. */
function globalReplyProblems(body: string, allowIds: boolean): string[] {
  const out: string[] = [];
  const quote = JSON.stringify(body.length > 160 ? `${body.slice(0, 160)}…` : body);
  if (/\*\*|^\s*#{1,6}\s|^\s*[-*•]\s/m.test(body)) out.push(`reply has markdown: ${quote}`);
  if (/antml|<\/?(thinking|reasoning|system|function_calls|invoke|parameter)\b/i.test(body)) out.push(`reply leaks markup: ${quote}`);
  if (!allowIds && /\b(inv|pay|act|wd|ref|evt|ct|item|bank|led)_[a-z0-9]{4,}/i.test(body)) out.push(`reply shows a raw id: ${quote}`);
  if (body.length > 400) out.push(`reply is ${body.length} chars (max 400): ${quote}`);
  return out;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\$(\w+)/g, (m, k: string) => vars[k] ?? m);
}

function addDays(d: Date, days: number): string {
  return new Date(d.getTime() + days * 86400_000).toISOString();
}

// ------------------------------------------------------------------ run one case

interface Outcome {
  status: "PASS" | "FAIL" | "SKIP";
  reasons: string[];
}

async function runCase(c: Case): Promise<Outcome> {
  const record: RecordedSend[] = [];
  const replies: { body: string; messageId: string }[] = [];
  const fixedNow = c.now ? new Date(c.now) : null;
  const agent = buildAgent({
    ...(fixedNow ? { now: () => fixedNow } : {}),
    outbox: createConsoleOutbox({ log: () => {}, record }),
    config: { ...config, offline: true, mockCards: true },
    mockStepDelayMs: 0,
    log: () => {},
  });
  const { store } = agent.deps;
  const vars: Record<string, string> = {};
  const now = agent.deps.now();

  // --- setup
  const shopLine = (amount: string) => ({ menuItemId: null, name: "Payment", qty: 1, unit: money(amount, "SGD") });
  if (c.setup?.addBank) {
    if (!store.mock) throw new Error("setup.addBank needs the memory store (store.mock)");
    await store.mock.addBankAccount({
      merchantId: DEMO_MERCHANT.id,
      type: "bank_account",
      bankName: "DBS",
      last4: "1234",
      holderName: "AH SENG FOOD PTE LTD",
      beneficiaryId: "sx_bene_eval",
      status: "verified",
      isDefault: true,
    });
  }
  if (c.setup?.createCode) {
    const { amount, expired } = c.setup.createCode;
    const inv = await store.createInvoice({
      merchantId: DEMO_MERCHANT.id,
      kind: "one_time_qr",
      contactId: null,
      to: null,
      lines: [shopLine(amount)],
      total: money(amount, "SGD"),
      note: null,
      expiresAt: expired ? addDays(now, -1) : new Date(now.getTime() + 30 * 60_000).toISOString(),
    });
    vars.code = inv.code;
  }
  if (c.setup?.invoiceCustomer) {
    const { amount } = c.setup.invoiceCustomer;
    const inv = await store.createInvoice({
      merchantId: DEMO_MERCHANT.id,
      kind: "invoice",
      contactId: null,
      to: CUSTOMER,
      lines: [shopLine(amount)],
      total: money(amount, "SGD"),
      note: null,
      expiresAt: addDays(now, 7),
    });
    vars.invoiceCode = inv.code;
  }
  if (c.setup?.payInvoice) {
    if (!store.mock) throw new Error("setup.payInvoice needs the memory store (store.mock)");
    const { amount } = c.setup.payInvoice;
    const inv = await store.createInvoice({
      merchantId: DEMO_MERCHANT.id,
      kind: "invoice",
      contactId: null,
      to: CUSTOMER,
      lines: [shopLine(amount)],
      total: money(amount, "SGD"),
      note: null,
      expiresAt: addDays(now, 7),
    });
    const payment = await store.mock.payInvoice(inv.code, CUSTOMER);
    vars.paymentId = payment.id;
    vars.paidCode = inv.code;
  }

  // --- instrumentation
  const turnResults: TurnResult[] = [];
  const realTurn = agent.turns.turn.bind(agent.turns);
  agent.turns.turn = async (input) => {
    const result = await realTurn(input);
    turnResults.push(result);
    return result;
  };
  let transcript = "";
  agent.voice.transcribe = async () => transcript;
  agent.voice.speak = async () => null;

  const workerCounts: Record<string, number> = {};
  const worker = agent.deps.worker as unknown as Record<string, unknown>;
  for (const method of ["createWithdrawal", "executeWithdrawal", "refund", "createMerchant", "setAutoWithdraw"]) {
    const fn = worker[method];
    if (typeof fn !== "function") continue;
    workerCounts[method] = 0;
    worker[method] = (...args: unknown[]) => {
      workerCounts[method]! += 1;
      return (fn as (...a: unknown[]) => unknown).apply(agent.deps.worker, args);
    };
  }

  let replyN = 0;
  const reply: ReplyChannel = {
    async text(body) {
      const messageId = `eval-reply-${++replyN}`;
      replies.push({ body, messageId });
      return { messageId };
    },
    async responding(fn) {
      return fn();
    },
  };

  const from = c.as === "merchant" ? MERCHANT : c.as === "customer" ? CUSTOMER : STRANGER;

  const lastConfirmId = (): string | null => {
    const candidates: { messageId: string; i: number }[] = [];
    record.forEach((s, i) => {
      const isConfirmCard = kindMatches(s.kind, "confirm") || kindMatches(s.kind, "withdrawal");
      const isThumbText = s.body.trimStart().startsWith("👍");
      if ((isConfirmCard || isThumbText) && s.to === from.phone) candidates.push({ messageId: s.messageId, i });
    });
    const fromReplies = replies.filter((r) => r.body.trimStart().startsWith("👍"));
    if (candidates.length) return candidates[candidates.length - 1]!.messageId;
    return fromReplies.length ? fromReplies[fromReplies.length - 1]!.messageId : null;
  };

  // --- replay
  for (const { inbound } of c.turns) {
    let msg: Inbound;
    switch (inbound.type) {
      case "text":
        msg = { type: "text", text: fill(inbound.text, vars) };
        break;
      case "voice":
        transcript = fill(inbound.transcript, vars);
        msg = { type: "voice", audio: Buffer.alloc(0), mimeType: "audio/x-caf" };
        break;
      case "reaction": {
        const target = inbound.target === "$lastConfirm" ? lastConfirmId() : fill(inbound.target, vars);
        if (!target) return { status: "FAIL", reasons: [`no confirm message to react to; replies so far: ${JSON.stringify(replies.map((r) => r.body))}`] };
        msg = { type: "reaction", emoji: inbound.emoji, targetMessageId: target };
        break;
      }
      case "contact":
        msg = { type: "contact", name: inbound.name, phones: inbound.phones, note: inbound.note };
        break;
      case "poll_option":
        msg = { type: "poll_option", title: inbound.title, pollTitle: inbound.pollTitle, selected: inbound.selected };
        break;
      case "web_confirm": {
        const open = await store.findOpenActionsForMerchant(DEMO_MERCHANT.id);
        const latest = open.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        if (!latest) return { status: "FAIL", reasons: ["web_confirm: no open action"] };
        await agent.actions.confirm(latest.id, inbound.via);
        continue;
      }
    }
    await handleInbound(agent, from, msg, reply);
  }
  // let mock-worker follow-ups (events) settle
  await new Promise((r) => setTimeout(r, 20));

  // --- assertions
  const reasons: string[] = [];
  const e = c.expect;
  const calls = turnResults.flatMap((t) => t.toolCalls);
  const called = new Set(calls.map((t) => t.name));
  const replyText = replies.map((r) => r.body).join("\n");
  const allText = [replyText, ...record.map((s) => s.body)].join("\n");
  const phoneOf = (who: "merchant" | "customer" | "sender") => (who === "merchant" ? MERCHANT.phone : who === "customer" ? CUSTOMER.phone : from.phone);

  for (const t of e.tools ?? []) if (!called.has(t)) reasons.push(`expected tool ${t}; called [${[...called].join(", ")}]`);
  for (const t of e.notTools ?? []) if (called.has(t)) reasons.push(`tool ${t} must not be called`);
  for (const { tool, match } of e.toolInput ?? []) {
    const filled = JSON.parse(fill(JSON.stringify(match), vars)) as unknown;
    const inputs = calls.filter((x) => x.name === tool).map((x) => x.input);
    if (!inputs.some((i) => partialMatch(i, filled))) reasons.push(`${tool} input ${JSON.stringify(filled)} not matched; got ${JSON.stringify(inputs)}`);
  }
  for (const r of e.replyMatches ?? []) if (!re(r).test(replyText)) reasons.push(`reply !~ /${r}/: ${JSON.stringify(replyText)}`);
  for (const r of e.replyNotMatches ?? []) if (re(r).test(replyText)) reasons.push(`reply ~ /${r}/ (forbidden)`);
  for (const r of e.textMatches ?? []) if (!re(fill(r, vars)).test(allText)) reasons.push(`no text ~ /${r}/`);
  for (const r of e.textNotMatches ?? []) if (re(r).test(allText)) reasons.push(`text ~ /${r}/ (forbidden)`);
  for (const s of e.sends ?? []) {
    const hit = record.some(
      (x) =>
        kindMatches(x.kind, s.kind) &&
        (!s.contains || x.body.toLowerCase().includes(fill(s.contains, vars).toLowerCase())) &&
        (!s.to || x.to === phoneOf(s.to)),
    );
    if (!hit) reasons.push(`expected send ${JSON.stringify(s)}; sent [${record.map((x) => `${x.kind}→${x.to}`).join(", ")}]`);
  }
  for (const k of e.noSends ?? []) if (record.some((x) => kindMatches(x.kind, k))) reasons.push(`send of kind ${k} must not happen`);
  if (e.claudeCalled !== undefined && (turnResults.length > 0) !== e.claudeCalled)
    reasons.push(`claudeCalled expected ${e.claudeCalled}, got ${turnResults.length > 0}`);
  for (const { method, count } of e.workerCalls ?? []) {
    const n = workerCounts[method] ?? 0;
    if (n !== count) reasons.push(`worker.${method} called ${n}×, expected ${count}`);
  }
  if (turnResults.some((t) => t.refused)) reasons.push("a turn ended in a refusal");
  for (const r of replies) reasons.push(...globalReplyProblems(r.body, c.allowIds ?? false));
  return { status: reasons.length ? "FAIL" : "PASS", reasons };
}

// ------------------------------------------------------------------ main

const casesDir = join(here, "cases");
const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
const cases = files.map((f) => {
  const parsed = CaseZ.safeParse(JSON.parse(readFileSync(join(casesDir, f), "utf8")));
  if (!parsed.success) throw new Error(`${f}: ${parsed.error.message}`);
  return parsed.data;
});

const argv = process.argv.slice(2);
const flag = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
const only = flag("--only");
const repeat = Math.max(1, Number(flag("--repeat")[0] ?? 1));
const concurrency = Math.max(1, Number(flag("--concurrency")[0] ?? 1));
const selected = only.length ? cases.filter((c) => only.includes(c.id)) : cases;
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

interface Run {
  c: Case;
  n: number;
}
const runnable = selected.filter((c) => !((c.needsClaude ?? c.expect.claudeCalled !== false) && !hasKey));
const skipped = selected.filter((c) => !runnable.includes(c));
for (const c of skipped) console.log(`SKIP  ${c.id}  (needs ANTHROPIC_API_KEY)`);

const queue: Run[] = runnable.flatMap((c) => Array.from({ length: repeat }, (_, n) => ({ c, n: n + 1 })));
const results = new Map<string, Outcome[]>();
let pass = 0;
let fail = 0;

async function worker(): Promise<void> {
  for (let run = queue.shift(); run; run = queue.shift()) {
    const { c, n } = run;
    const started = Date.now();
    let outcome: Outcome;
    try {
      outcome = await runCase(c);
    } catch (err) {
      outcome = { status: "FAIL", reasons: [`threw: ${err instanceof Error ? err.message : String(err)}`] };
    }
    const ms = Date.now() - started;
    if (outcome.status === "PASS") pass++;
    else fail++;
    results.set(c.id, [...(results.get(c.id) ?? []), outcome]);
    const tag = repeat > 1 ? ` #${n}` : "";
    const lines = [`${outcome.status}  ${c.id}${tag}  (${ms} ms)  ${c.description}`, ...outcome.reasons.map((r) => `      - ${r}`)];
    console.log(lines.join("\n"));
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (repeat > 1) {
  console.log("\nPer-case pass rate:");
  for (const c of runnable) {
    const rs = results.get(c.id) ?? [];
    const ok = rs.filter((r) => r.status === "PASS").length;
    console.log(`  ${ok === rs.length ? "  " : "!!"} ${ok}/${rs.length}  ${c.id}`);
  }
}
console.log(`\n${pass} passed · ${fail} failed · ${skipped.length} skipped · ${runnable.length * repeat + skipped.length} total`);
process.exit(fail ? 1 : 0);
