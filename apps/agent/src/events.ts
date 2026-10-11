// Events from the worker / web API → messages and card edits. [stub]
import type { ActionsService, Deps, EventsHandler, OnboardingFlow } from "./ports";
export function createEventsHandler(_deps: Deps, _m: { actions: ActionsService; onboarding: OnboardingFlow }): EventsHandler {
  throw new Error("not implemented: createEventsHandler");
}
