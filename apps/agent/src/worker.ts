// Worker client: real HTTP (internal routes) + an offline mock against the memory store. [stub]
import type { EventEnvelope } from "@rove/shared";
import type { Config } from "./env";
import type { Store, WorkerClient } from "./ports";
export function createHttpWorker(_config: Config): WorkerClient {
  throw new Error("not implemented: createHttpWorker");
}
export function createMockWorker(_store: Store, _emit: (e: EventEnvelope) => Promise<unknown>, _opts?: { stepDelayMs?: number }): WorkerClient {
  throw new Error("not implemented: createMockWorker");
}
