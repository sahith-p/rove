// menu items

import { newId, type MenuItem } from "@rove/shared";
import { DbConflictError } from "../errors";
import type { Executor, Pool } from "../executor";
import type { Db, MenuMatch } from "../index";
import { MENU_COLS, norm, toMenuItem } from "../map";
import { matchName } from "../match";
import { lockMerchant } from "./util";

type MenuRepo = Pick<Db, "listMenu" | "replaceMenu" | "upsertMenuItem" | "findMenuItems">;

const key = (name: string) => name.trim().toLowerCase();

async function listIn(q: Executor, merchantId: string, includeInactive: boolean): Promise<MenuItem[]> {
  const rows = await q.query(
    `select ${MENU_COLS} from menu_items where merchant_id = $1 ${includeInactive ? "" : "and active"} order by sort, name`,
    [merchantId],
  );
  return rows.map(toMenuItem);
}

export function menuRepo(pool: Pool): MenuRepo {
  return {
    listMenu: (merchantId, opts) => listIn(pool, merchantId, opts?.includeInactive ?? false),

    async replaceMenu(merchantId, items) {
      const seen = new Set<string>();
      for (const it of items) {
        const k = key(it.name);
        if (!k) throw new Error("@rove/db: menu item name is empty");
        if (seen.has(k)) throw new DbConflictError(`duplicate menu item name: ${it.name.trim()}`, "menu_items_merchant_id_name_key");
        seen.add(k);
      }

      return pool.tx(async (q) => {
        if (!(await lockMerchant(q, merchantId))) throw new Error(`@rove/db: unknown merchant ${merchantId}`);
        const existing = await listIn(q, merchantId, true);
        const byId = new Map(existing.map((e) => [e.id, e]));
        const byName = new Map(existing.map((e) => [key(e.name), e]));

        // Resolve each input to an existing row: by id (kept when editing), else by name, else a new row.
        const claimed = new Set<string>();
        const plan = items.map((it, i) => {
          let target = it.id && byId.has(it.id) && !claimed.has(it.id) ? it.id : undefined;
          if (!target) {
            const e = byName.get(key(it.name));
            if (e && !claimed.has(e.id)) target = e.id;
          }
          if (target) claimed.add(target);
          return { id: target ?? null, name: it.name.trim(), price: norm(it.price), active: it.active ?? true, sort: i + 1 };
        });

        // Rows not listed are deleted: the merchant removed them in the setup card (hiding is `active: false`).
        // Invoices and payments keep their own copy of each line in jsonb, so nothing references these rows.
        for (const e of existing) {
          if (!claimed.has(e.id)) await q.query(`delete from menu_items where id = $1`, [e.id]);
        }
        for (const p of plan) {
          if (p.id && byId.get(p.id)!.name !== p.name) await q.query(`update menu_items set name = '~' || id where id = $1`, [p.id]);
        }

        const ids: string[] = [];
        for (const p of plan) {
          if (p.id) {
            await q.query(`update menu_items set name = $2, price = $3::numeric, currency = $4, active = $5, sort = $6 where id = $1`, [
              p.id,
              p.name,
              p.price.amount,
              p.price.currency,
              p.active,
              p.sort,
            ]);
            ids.push(p.id);
          } else {
            const id = newId("item");
            await q.query(
              `insert into menu_items (id, merchant_id, name, price, currency, active, sort) values ($1, $2, $3, $4::numeric, $5, $6, $7)`,
              [id, merchantId, p.name, p.price.amount, p.price.currency, p.active, p.sort],
            );
            ids.push(id);
          }
        }
        const wanted = new Set(ids);
        return (await listIn(q, merchantId, true)).filter((m) => wanted.has(m.id));
      });
    },

    async upsertMenuItem(merchantId, item) {
      const name = item.name.trim();
      if (!name) throw new Error("@rove/db: menu item name is empty");
      const price = item.price ? norm(item.price) : null;
      return pool.tx(async (q) => {
        if (!(await lockMerchant(q, merchantId))) throw new Error(`@rove/db: unknown merchant ${merchantId}`);
        const found = await q.query(
          `select id from menu_items where merchant_id = $1 and lower(name) = lower($2) order by active desc, sort limit 1`,
          [merchantId, name],
        );
        if (found[0]) {
          // Updating (or re-adding) an item makes it active again unless told otherwise.
          const rows = await q.query(
            `update menu_items set price = coalesce($2::numeric, price), currency = coalesce($3, currency), active = $4
              where id = $1 returning ${MENU_COLS}`,
            [String(found[0].id), price?.amount ?? null, price?.currency ?? null, item.active ?? true],
          );
          return toMenuItem(rows[0]!);
        }
        if (!price) throw new Error(`@rove/db: menu item "${name}" doesn't exist yet, so it needs a price`);
        const rows = await q.query(
          `insert into menu_items (id, merchant_id, name, price, currency, active, sort)
           values ($1, $2, $3, $4::numeric, $5, $6, (select coalesce(max(sort), 0) + 1 from menu_items where merchant_id = $2))
           returning ${MENU_COLS}`,
          [newId("item"), merchantId, name, price.amount, price.currency, item.active ?? true],
        );
        return toMenuItem(rows[0]!);
      });
    },

    async findMenuItems(merchantId, names): Promise<MenuMatch[]> {
      const menu = await listIn(pool, merchantId, false);
      return names.map((query) => {
        const r = matchName(query, menu, (m) => m.name);
        return { query, item: r.match, suggestions: r.match ? [] : r.suggestions.map((m) => m.name) };
      });
    },
  };
}
