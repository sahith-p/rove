// What every tool closes over. Tools never take a merchant id or a sender phone from the model:
// both come from here (the sender's phone decides who they are).

import type { Merchant, Recipient } from "@rove/shared";
import type { ToolCallLog } from "../agent/tool";
import type { ActionsService, Deps, OnboardingFlow } from "../ports";

export interface ToolContext {
  deps: Deps;
  /** The person texting Rove right now. */
  from: Recipient;
  /** Set for the merchant persona (a live merchant's own phone). */
  merchant: Merchant | null;
  actions: ActionsService;
  onboarding: OnboardingFlow;
  calls: ToolCallLog;
}
