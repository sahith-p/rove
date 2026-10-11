// emit(): tell the agent something happened (shop.updated, bank_account.added). Owner: Nithya (NI-C1).
// Copy of apps/worker/src/emit.ts (separate deployable): EventEnvelope → `events` table → POST ${AGENT_URL}/internal/events
// with 3 tries + backoff → mark delivered on 2xx. Never throws to the caller; the worker's boot replays undelivered rows.

import { EventEnvelopeZ, internalHeaders, newId, ROUTES, type EventEnvelope, type RoveEvent } from "@rove/shared";
import type { Db } from "@rove/db";

export interface Emit {
  /** Record + deliver a new event. Resolves after delivery succeeded or retries ran out; never rejects. */
  (event: RoveEvent): Promise<void>;
  /** Re-deliver an existing envelope (same id) without inserting it again. True if the agent acknowledged it. */
  deliver(envelope: EventEnvelope): Promise<boolean>;
}

type Fields = Record<string, unknown>;
export interface EmitLog {
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export const consoleEmitLog: EmitLog = {
  warn: (msg, f) => console.warn(`[api:emit] ${msg}`, f ?? ""),
  error: (msg, f) => console.error(`[api:emit] ${msg}`, f ?? ""),
};

export interface EmitterOptions {
  db: Pick<Db, "insertEvent" | "markEventDelivered">;
  agentUrl: string;
  secret: string;
  log?: EmitLog;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Delays before retry 2 and 3 (ms). Default [300, 1500]. */
  backoffMs?: number[];
  /** Per-attempt timeout (ms). Default 5000. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createEmitter(opts: EmitterOptions): Emit {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const backoff = opts.backoffMs ?? [300, 1500];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const log = opts.log ?? consoleEmitLog;
  const url = `${opts.agentUrl.replace(/\/$/, "")}${ROUTES.agent.events}`;

  async function deliver(envelope: EventEnvelope): Promise<boolean> {
    const ctx = { eventId: envelope.id, type: envelope.event.type };
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      if (attempt > 0) await sleep(backoff[attempt - 1] ?? 0);
      let retryable = true;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: internalHeaders(opts.secret),
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          try {
            await opts.db.markEventDelivered(envelope.id);
          } catch (err) {
            log.warn("event delivered but not marked (the agent dedupes a resend)", { ...ctx, err: String(err) });
          }
          return true;
        }
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        log.warn("agent rejected event", { ...ctx, status: res.status, attempt: attempt + 1 });
      } catch (err) {
        log.warn("agent unreachable", { ...ctx, attempt: attempt + 1, err: err instanceof Error ? err.message : String(err) });
      }
      if (!retryable) break;
    }
    log.warn("event not delivered; it stays in the events table for replay", ctx);
    return false;
  }

  const emit = async (event: RoveEvent): Promise<void> => {
    const envelope: EventEnvelope = { id: newId("evt"), at: now().toISOString(), event };
    const check = EventEnvelopeZ.safeParse(envelope);
    if (!check.success) {
      log.error("refusing to emit an invalid event", { type: event.type, issues: check.error.issues });
      return;
    }
    try {
      await opts.db.insertEvent(envelope);
    } catch (err) {
      log.error("could not record event; delivering anyway", { eventId: envelope.id, type: event.type, err: String(err) });
    }
    try {
      await deliver(envelope);
    } catch (err) {
      log.error("event delivery crashed", { eventId: envelope.id, type: event.type, err: String(err) });
    }
  };

  return Object.assign(emit, { deliver });
}
