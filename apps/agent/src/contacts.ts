// Contact-card intake: a merchant shares a contact into the chat → saved as one of their customers.
// The card's note (and every other free-text field besides the name) is ignored: it's someone else's text.

import type { Merchant } from "@rove/shared";
import type { Deps, Inbound } from "./ports";
import { toE164 } from "./tools/match";

export async function addContactFromCard(deps: Deps, merchant: Merchant, card: Extract<Inbound, { type: "contact" }>): Promise<string> {
  const phone = card.phones.map(toE164).find((p): p is string => p !== null);
  if (!phone) return "That card has no phone number.";
  const name = card.name?.replace(/\s+/g, " ").trim().slice(0, 60) || "Unknown";
  const contact = await deps.store.addContact(merchant.id, { name, phone, channel: null });
  return `Saved ${contact.name} (${contact.phone}) ✓`;
}
