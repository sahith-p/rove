// Demo data, upserted with fixed ids so the fixtures (demoInvoice, demoPayment) line up with the rows. Idempotent.
//   seedDemoData:    ahseng (SGD): DEMO_MERCHANT, DEMO_MENU, DEMO_CONTACTS from @rove/shared/mocks
//   seedEurDemoData: cafe-berlin (EUR, the corridors demo shop): DEMO_EUR_MERCHANT, DEMO_EUR_MENU
// Used by scripts/seed-demo.ts (both) and createTestDb({ demo: true }) (ahseng only).

import type { Contact, CredentialStatus, MenuItem, Merchant } from "@rove/shared";
import { DEMO_CONTACTS, DEMO_EUR_MENU, DEMO_EUR_MERCHANT, DEMO_MENU, DEMO_MERCHANT } from "@rove/shared/mocks";
import type { Pool } from "./executor";
import { norm } from "./map";

export interface DemoSeedOptions {
  /** The demo merchant's custodial XRPL account (from the XRPL seed script); unchanged when omitted. */
  xrplAddress?: string | null;
  /** Its AES-256-GCM encrypted seed (WALLET_ENCRYPTION_KEY); unchanged when omitted. */
  xrplSeedEnc?: string | null;
  credentialStatus?: CredentialStatus | null;
}

export interface DemoSeedResult {
  merchantId: string;
  menuItems: number;
  contacts: number;
}

async function seedMerchant(pool: Pool, m: Merchant, menu: MenuItem[], contacts: Contact[], opts: DemoSeedOptions): Promise<DemoSeedResult> {
  await pool.tx(async (q) => {
    await q.query(
      `insert into merchants (id, name, phone, channel, category, country, currency, status, xrpl_address, xrpl_seed_enc, credential_status)
       values ($1, $2, $3, $4, $5, $6, $7, 'live', $8, $9, coalesce($10, $11))
       on conflict (id) do update set
         name = excluded.name, phone = excluded.phone, channel = excluded.channel, category = excluded.category,
         country = excluded.country, currency = excluded.currency, status = 'live',
         xrpl_address = coalesce($8, merchants.xrpl_address),
         xrpl_seed_enc = coalesce($9, merchants.xrpl_seed_enc),
         credential_status = coalesce($10, merchants.credential_status)`,
      [
        m.id,
        m.name,
        m.phone,
        m.channel,
        m.category,
        m.country,
        m.currency,
        opts.xrplAddress ?? null,
        opts.xrplSeedEnc ?? null,
        opts.credentialStatus ?? null,
        m.credentialStatus,
      ],
    );
    for (const item of menu) {
      const price = norm(item.price);
      await q.query(
        `insert into menu_items (id, merchant_id, name, price, currency, active, sort) values ($1, $2, $3, $4::numeric, $5, $6, $7)
         on conflict (id) do update set name = excluded.name, price = excluded.price, currency = excluded.currency,
           active = excluded.active, sort = excluded.sort`,
        [item.id, item.merchantId, item.name, price.amount, price.currency, item.active, item.sort],
      );
    }
    for (const c of contacts) {
      await q.query(
        `insert into contacts (id, merchant_id, name, phone, channel) values ($1, $2, $3, $4, $5)
         on conflict (merchant_id, phone) do update set name = excluded.name, channel = excluded.channel`,
        [c.id, c.merchantId, c.name, c.phone, c.channel],
      );
    }
  });
  return { merchantId: m.id, menuItems: menu.length, contacts: contacts.length };
}

/** ahseng (SGD), its menu and Maya. */
export function seedDemoData(pool: Pool, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  return seedMerchant(pool, DEMO_MERCHANT, DEMO_MENU, DEMO_CONTACTS, opts);
}

/** cafe-berlin (EUR, country DE) and its EUR menu. No contacts. */
export function seedEurDemoData(pool: Pool, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  return seedMerchant(pool, DEMO_EUR_MERCHANT, DEMO_EUR_MENU, [], opts);
}
