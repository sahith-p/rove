// Shared unit-test harness (no tests of its own): a full offline agent on the memory store + mock worker
// (stepDelayMs 0) + recording console outbox, with an adjustable clock and worker-call counters.
// Never touches production: no DATABASE_URL, Photon, Claude or ElevenLabs (keys are blanked).

import type { EventEnvelope, Recipient, RoveEvent } from "@rove/shared";
import { DEMO_CUSTOMER, DEMO_MERCHANT } from "@rove/shared/mocks";
import { buildAgent, type Agent } from "./app";
import { config } from "./env";
import { createConsoleOutbox, type RecordedSend } from "./outbox";
import type { WorkerClient } from "./ports";

export const START = new Date("2026-10-11T19:00:00.000Z");
export const MERCHANT: Recipient = { phone: DEMO_MERCHANT.phone, channel: "imessage" };
export const CUSTOMER: Recipient = { phone: DEMO_CUSTOMER.phone, channel: "imessage" };
export const STRANGER: Recipient = { phone: "+6590009999", channel: "imessage" };

export interface Harness {
  agent: Agent;
  record: RecordedSend[];
  logs: unknown[][];
  workerCalls: Record<string, number>;
  now(): Date;
  advance(ms: number): void;
  /** Recorded sends to one phone, optionally filtered by kind prefix ("text", "card:confirm", "card-edit:", …). */
  sentTo(phone: string, kind?: string): RecordedSend[];
  texts(phone: string): string[];
  clear(): void;
  emit(event: RoveEvent, id?: string): Promise<"handled" | "duplicate">;
}

let envN = 0;

export function makeHarness(o: { start?: Date; config?: Partial<typeof config> } = {}): Harness {
  let t = (o.start ?? START).getTime();
  const now = () => new Date(t);
  const record: RecordedSend[] = [];
  const logs: unknown[][] = [];
  const agent = buildAgent({
    outbox: createConsoleOutbox({ log: () => undefined, record }),
    config: { ...config, offline: true, mockCards: true, anthropicApiKey: "", elevenLabs: { apiKey: "", voiceId: "" }, ...o.config },
    now,
    mockStepDelayMs: 0,
    log: (...a) => logs.push(a),
  });
  // No PNG rendering in unit tests: senders fall back to text links.
  agent.deps.qr = { qrPng: async () => null, stickerPng: async () => null };

  const workerCalls: Record<string, number> = {};
  const w = agent.deps.worker as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const k of Object.keys(w) as (keyof WorkerClient)[]) {
    const orig = w[k]!;
    workerCalls[k] = 0;
    w[k] = (...a: unknown[]) => {
      workerCalls[k]!++;
      return orig(...a);
    };
  }

  return {
    agent,
    record,
    logs,
    workerCalls,
    now,
    advance: (ms) => {
      t += ms;
    },
    sentTo: (phone, kind) => record.filter((r) => r.to === phone && (!kind || r.kind.startsWith(kind))),
    texts: (phone) => record.filter((r) => r.to === phone && r.kind === "text").map((r) => r.body),
    clear: () => {
      record.length = 0;
    },
    emit: (event, id) => {
      const env: EventEnvelope = { id: id ?? `evt_test_${++envN}`, at: now().toISOString(), event };
      return agent.events.handle(env);
    },
  };
}
