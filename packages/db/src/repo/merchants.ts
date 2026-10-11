// merchants + shop lookup

import type { Merchant } from "@rove/shared";
import { DbConflictError } from "../errors";
import type { Param, Pool } from "../executor";
import type { Db, ShopMatch } from "../index";
import { MERCHANT_COLS, normalizePhone, phoneDigits, toMerchant } from "../map";
import { fuzzyBudget, levenshtein, matchName, normalizeName } from "../match";
import { inJson, SetBuilder } from "./util";

type MerchantsRepo = Pick<
  Db,
  | "getMerchant"
  | "getMerchantByPhone"
  | "findShop"
  | "upsertDraftMerchant"
  | "updateShop"
  | "setMerchantXrpl"
  | "getMerchantSeedEnc"
  | "setMerchantLive"
  | "setAutoWithdraw"
  | "listLiveMerchants"
>;

const PHONE_LIKE = /^\+?[\d\s().-]+$/;

/** Digit strings a typed phone could mean: as typed, plus +65 for 8-digit SG numbers and +1 for 10-digit US numbers. */
function phoneVariants(digits: string): string[] {
  const out = [digits];
  if (digits.length === 8) out.push(`65${digits}`);
  if (digits.length === 10) out.push(`1${digits}`);
  return out;
}

function uniqueById(ms: Merchant[]): Merchant[] {
  const seen = new Set<string>();
  return ms.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export function merchantsRepo(pool: Pool): MerchantsRepo {
  const one = async (sql: string, params: Param[]) => {
    const rows = await pool.query(sql, params);
    return rows[0] ? toMerchant(rows[0]) : null;
  };

  return {
    getMerchant: (id) => one(`select ${MERCHANT_COLS} from merchants where id = $1`, [id]),

    async getMerchantByPhone(phone) {
      const digits = phoneDigits(phone);
      if (!digits) return null;
      return one(
        `select ${MERCHANT_COLS} from merchants
          where phone = $1 or regexp_replace(phone, '[^0-9]', '', 'g') = $2
          order by (phone = $1) desc, created_at limit 1`,
        [normalizePhone(phone), digits],
      );
    },

    async findShop(query): Promise<ShopMatch> {
      const raw = query.trim().replace(/^@/, "");
      if (!raw) return { merchant: null, candidates: [] };

      // 1. shop code (the merchant id), case-insensitive
      const byCode = await one(`select ${MERCHANT_COLS} from merchants where status = 'live' and lower(id) = lower($1)`, [raw]);
      if (byCode) return { merchant: byCode, candidates: [] };

      // 2. merchant phone (any formatting; local SG / US numbers without the country code)
      const digits = phoneDigits(raw);
      if (PHONE_LIKE.test(raw) && digits.length >= 7) {
        const rows = await pool.query(
          `select ${MERCHANT_COLS} from merchants
            where status = 'live' and regexp_replace(phone, '[^0-9]', '', 'g') in ${inJson(1)}
            order by created_at`,
          [JSON.stringify(phoneVariants(digits))],
        );
        const ms = rows.map(toMerchant);
        return ms.length === 1 ? { merchant: ms[0]!, candidates: [] } : { merchant: null, candidates: ms };
      }

      // 3. name: exact → prefix → word prefix → fuzzy; several hits → candidates
      const live = (await pool.query(`select ${MERCHANT_COLS} from merchants where status = 'live' order by created_at`)).map(toMerchant);
      const byName = matchName(raw, live, (m) => m.name);
      if (byName.match) return { merchant: byName.match, candidates: [] };
      if (byName.ambiguous.length) return { merchant: null, candidates: byName.ambiguous };

      // 4. a typo'd shop code ("ahsen" → ahseng): fuzzy only, the closest unique one wins
      const q = normalizeName(raw).replace(/\s+/g, "");
      const budget = fuzzyBudget(q.length);
      const near = live
        .map((m) => ({ m, d: levenshtein(q, m.id.replace(/-/g, "")) }))
        .filter((s) => s.d <= budget)
        .sort((a, b) => a.d - b.d);
      if (near.length === 1 || (near.length > 1 && near[0]!.d < near[1]!.d)) return { merchant: near[0]!.m, candidates: [] };
      if (near.length > 1) return { merchant: null, candidates: near.map((s) => s.m) };

      // nothing confident: the closest names, so the agent can ask "did you mean …?"
      return { merchant: null, candidates: uniqueById(byName.suggestions) };
    },

    async upsertDraftMerchant(m) {
      // Same id + same phone → update in place (idempotent). Same id, different phone → the slug is someone else's shop.
      const row = await one(
        `insert into merchants (id, name, phone, channel, category, currency)
         values ($1, $2, $3, $4, $5, coalesce($6, 'SGD'))
         on conflict (id) do update set
           name = excluded.name,
           channel = excluded.channel,
           category = coalesce(excluded.category, merchants.category),
           currency = coalesce($6, merchants.currency)
         where merchants.phone = excluded.phone
         returning ${MERCHANT_COLS}`,
        [m.id, m.name, normalizePhone(m.phone), m.channel, m.category ?? null, m.currency ?? null],
      );
      if (!row) throw new DbConflictError(`merchant id "${m.id}" belongs to another phone`, "merchants_pkey");
      return row;
    },

    async updateShop(id, patch) {
      const params: Param[] = [id];
      const set = new SetBuilder(params);
      if (patch.name !== undefined) set.add("name", patch.name);
      if ("category" in patch && patch.category !== undefined) set.add("category", patch.category);
      if (patch.currency !== undefined) set.add("currency", patch.currency);
      if (!set.sets.length) return one(`select ${MERCHANT_COLS} from merchants where id = $1`, params);
      return one(`update merchants set ${set.sql} where id = $1 returning ${MERCHANT_COLS}`, params);
    },

    setMerchantXrpl: (id, a) =>
      one(
        `update merchants set xrpl_address = $2, xrpl_seed_enc = $3, credential_status = $4 where id = $1 returning ${MERCHANT_COLS}`,
        [id, a.xrplAddress, a.xrplSeedEnc, a.credentialStatus],
      ),

    async getMerchantSeedEnc(xrplAddress) {
      const rows = await pool.query<{ xrpl_seed_enc: string | null }>(`select xrpl_seed_enc from merchants where xrpl_address = $1`, [
        xrplAddress,
      ]);
      return rows[0]?.xrpl_seed_enc ?? null;
    },

    setMerchantLive: (id) =>
      one(`update merchants set status = 'live' where id = $1 and status = 'draft' returning ${MERCHANT_COLS}`, [id]),

    async setAutoWithdraw(id, mode) {
      await pool.query(`update merchants set auto_withdraw = $2 where id = $1`, [id, mode]);
    },

    async listLiveMerchants() {
      return (await pool.query(`select ${MERCHANT_COLS} from merchants where status = 'live' order by created_at, id`)).map(toMerchant);
    },
  };
}
