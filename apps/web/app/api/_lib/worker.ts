// Calls from the web API to the worker. Owner: Nithya (NI-C1).

import { internalHeaders, ROUTES } from "@rove/shared";
import { webConfigFromEnv, type WebConfig } from "./deps";

export interface NudgeOptions {
  config?: Pick<WebConfig, "workerUrl" | "internalSecret">;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the worker to settle an authorized payment now (Stripe webhook, BNB). Best effort: 2s timeout, never throws,
 * because the worker also polls `authorized` payments every few seconds. Resolves true if the worker accepted it.
 */
export async function nudgeWorkerSettle(paymentId: string, opts: NudgeOptions = {}): Promise<boolean> {
  const config = opts.config ?? webConfigFromEnv();
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${config.workerUrl.replace(/\/$/, "")}${ROUTES.worker.settle}`, {
      method: "POST",
      headers: internalHeaders(config.internalSecret),
      body: JSON.stringify({ paymentId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    if (!res.ok) console.warn(`[api] worker settle nudge for ${paymentId}: HTTP ${res.status} (the poller will retry)`);
    return res.ok;
  } catch (err) {
    console.warn(`[api] worker settle nudge for ${paymentId} failed (the poller will retry):`, err instanceof Error ? err.message : err);
    return false;
  }
}
