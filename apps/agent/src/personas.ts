// Who is texting: the sender's phone decides (agent.md §1). A live merchant's phone → merchant (merchant tools +
// customer tools); a phone mid-onboarding → onboarding; anyone else → customer.

import type { Merchant, Recipient } from "@rove/shared";
import type { AgentPersona, OnboardingState, Store } from "./ports";

export interface ResolvedPersona {
  persona: AgentPersona;
  merchant: Merchant | null;
  onboarding: OnboardingState | null;
}

export async function resolvePersona(store: Store, from: Recipient): Promise<ResolvedPersona> {
  const [merchant, onboarding] = await Promise.all([store.getMerchantByPhone(from.phone), store.getOnboarding(from.phone)]);
  if (merchant?.status === "live") return { persona: "merchant", merchant, onboarding };
  if (onboarding && onboarding.step !== "done") return { persona: "onboarding", merchant, onboarding };
  return { persona: "customer", merchant: null, onboarding };
}

const GREETING_RE = /^\s*(hi+|hello+|hey+|hiya|yo|start|get started)\s*[!.]*\s*$/i;

/** A first greeting from a stranger (no history, nothing owed, not a merchant) starts onboarding (onboarding.md). */
export async function shouldStartOnboarding(store: Store, from: Recipient, text: string): Promise<boolean> {
  if (!GREETING_RE.test(text)) return false;
  const [merchant, history, open] = await Promise.all([
    store.getMerchantByPhone(from.phone),
    store.recentAgentMessages(from.phone, 1),
    store.openInvoicesForPhone(from.phone),
  ]);
  return !merchant && history.length === 0 && open.length === 0;
}
