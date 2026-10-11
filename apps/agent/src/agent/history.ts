// Conversation memory: plain-text turns only, append-only (agent_messages). Tools re-read fresh state every
// turn, so the model never relies on stale numbers from history.

import { stripLeakedMarkup } from "./text";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Merchant, Persona, Recipient } from "@rove/shared";
import type { Store } from "../ports";

export const HISTORY_LIMIT = 20;

/** Recent turns as API messages: consecutive same-role turns merged, starting with a user turn. */
export async function loadHistory(store: Store, phone: string): Promise<BetaMessageParam[]> {
  const rows = await store.recentAgentMessages(phone, HISTORY_LIMIT);
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of rows) {
    const text = row.role === "assistant" ? stripLeakedMarkup(row.content) : row.content.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === row.role) last.content += `\n${text}`;
    else out.push({ role: row.role, content: text });
  }
  while (out[0]?.role === "assistant") out.shift();
  // The new user message follows, so history must end on an assistant turn to keep roles alternating.
  if (out[out.length - 1]?.role === "user") out.pop();
  return out;
}

export async function saveTurn(
  store: Store,
  v: { persona: Persona; from: Recipient; merchant: Merchant | null; user: string; assistant: string },
): Promise<void> {
  const base = { phone: v.from.phone, persona: v.persona, merchantId: v.merchant?.id ?? null, channel: v.from.channel };
  await store.appendAgentMessage({ ...base, role: "user", content: v.user });
  if (v.assistant) await store.appendAgentMessage({ ...base, role: "assistant", content: v.assistant });
}
