// emit(): tell the agent something happened. Owner: Nithya (NI-C1). Contract: @rove/shared events.ts.
// 1. wrap in an EventEnvelope { id: evt_…, at, event }   2. append to the `events` table
// 3. POST ${AGENT_URL}/internal/events (bearer INTERNAL_SECRET), up to 3 tries with backoff
// 4. on 2xx mark the row delivered. Undelivered rows are replayed by boot() through `emit.deliver(envelope)`.
// emit() never throws to the caller: a lost message must not undo a money step that already happened.
// The agent dedupes on envelope id (at-least-once). apps/web/app/api/_lib/emit.ts is a copy of this file (separate deployable).

import { EventEnvelopeZ, internalHeaders, newId, ROUTES, type EventEnvelope, type RoveEvent } from "@rove/shared";
import type { Db } from "@rove/db";
import type { Logger } from "./log";

export interface Emit {
  /** Record + deliver a new event. Resolves after delivery succeeded or retries ran out; never rejects. */
  (event: RoveEvent): Promise<void>;
  /** Re-deliver an existing envelope (same id) without inserting it again. True if the agent acknowledged it. */
  deliver(envelope: EventEnvelope): Promise<boolean>;
}

export interface EmitterOptions {
  db: Pick<Db, "insertEvent" | "markEventDelivered">;
  agentUrl: string;
  secret: string;
  log: Pick<Logger, "warn" | "error" | "debug">;
  /** Injected in tests. Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Delays before retry 2 and 3 (ms). Default [300, 1500]. Length + 1 = attempts. */
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
  const url = `${opts.agentUrl.replace(/\/$/, "")}${ROUTES.agent.events}`;
  const log = opts.log;

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
            log.warn("event delivered but not marked (boot will resend; the agent dedupes)", { ...ctx, err });
          }
          log.debug("event delivered", { ...ctx, attempt: attempt + 1 });
          return true;
        }
        // 4xx (except timeout / rate limit) won't get better by retrying: the agent rejected the envelope.
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        log.warn("agent rejected event", { ...ctx, status: res.status, attempt: attempt + 1 });
      } catch (err) {
        log.warn("agent unreachable", { ...ctx, attempt: attempt + 1, err: err instanceof Error ? err.message : String(err) });
      }
      if (!retryable) break;
    }
    log.warn("event not delivered; it stays in the events table for boot replay", ctx);
    return false;
  }

  const emit = async (event: RoveEvent): Promise<void> => {
    const envelope: EventEnvelope = { id: newId("evt"), at: now().toISOString(), event };
    const check = EventEnvelopeZ.safeParse(envelope);
    if (!check.success) {
      // A bug in the caller: the agent would reject it with a 400, so don't store or send it.
      log.error("refusing to emit an invalid event", { type: event.type, issues: check.error.issues });
      return;
    }
    try {
      await opts.db.insertEvent(envelope);
    } catch (err) {
      log.error("could not record event; delivering anyway", { eventId: envelope.id, type: event.type, err });
    }
    try {
      await deliver(envelope);
    } catch (err) {
      log.error("event delivery crashed", { eventId: envelope.id, type: event.type, err });
    }
  };

  return Object.assign(emit, { deliver });
}
