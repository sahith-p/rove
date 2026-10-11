// Shared types for /m/[merchantId]. Type-only imports, safe for server and client.
import type { CheckoutRes, PaymentStatusRes, ShopPublicRes } from "@rove/shared";
import type { z } from "zod";

export type ShopView = z.infer<typeof ShopPublicRes>;
export type CheckoutView = z.infer<typeof CheckoutRes>;
export type PaymentView = z.infer<typeof PaymentStatusRes>;

/** What the payer is paying for: menu items (priced by the server from the DB) or a typed amount. */
export type Selection = { kind: "items"; items: { menuItemId: string; qty: number }[] } | { kind: "amount"; amount: string };

/** Shop codes are merchant id slugs (`ahseng`). */
export const SHOP_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
