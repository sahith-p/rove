// Internal HTTP (Hono, :4002). [stub]
import type { ActionsService, Deps, EventsHandler } from "./ports";
export function startServer(_deps: Deps, _m: { events: EventsHandler; actions: ActionsService }): { close(): void } {
  throw new Error("not implemented: startServer");
}
