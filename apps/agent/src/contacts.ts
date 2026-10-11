// Contact-card intake (shared contact → merchant contact). [stub]
import type { Merchant } from "@rove/shared";
import type { Deps, Inbound } from "./ports";
export async function addContactFromCard(_deps: Deps, _merchant: Merchant, _card: Extract<Inbound, { type: "contact" }>): Promise<string> {
  throw new Error("not implemented: addContactFromCard");
}
