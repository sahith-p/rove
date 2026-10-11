import type { Contact, Merchant } from "@rove/shared";
import type { ToolContext } from "../context";

export function requireMerchant(ctx: ToolContext): Merchant {
  if (!ctx.merchant) throw new Error("merchant tools need a merchant");
  return ctx.merchant;
}

/** "Maya (+15555550199)" or the bare phone when we don't know them. */
export function personLabel(phone: string | null | undefined, contacts: Contact[]): string {
  if (!phone) return "walk-in";
  const c = contacts.find((x) => x.phone === phone);
  return c ? `${c.name} (${phone})` : phone;
}
