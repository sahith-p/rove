// a merchant's customer contacts

import { newId, type Contact } from "@rove/shared";
import type { Pool } from "../executor";
import type { Db } from "../index";
import { CONTACT_COLS, normalizePhone, phoneDigits, toContact } from "../map";
import { levenshtein, matchName, normalizeName } from "../match";

type ContactsRepo = Pick<Db, "addContact" | "findContacts" | "getContactByName">;

export function contactsRepo(pool: Pool): ContactsRepo {
  const all = async (merchantId: string): Promise<Contact[]> =>
    (await pool.query(`select ${CONTACT_COLS} from contacts where merchant_id = $1 order by lower(name), created_at`, [merchantId])).map(
      toContact,
    );

  return {
    async addContact(merchantId, c) {
      const rows = await pool.query(
        `insert into contacts (id, merchant_id, name, phone, channel) values ($1, $2, $3, $4, $5)
         on conflict (merchant_id, phone) do update set name = excluded.name, channel = coalesce(excluded.channel, contacts.channel)
         returning ${CONTACT_COLS}`,
        [newId("ct"), merchantId, c.name.trim(), normalizePhone(c.phone), c.channel ?? null],
      );
      return toContact(rows[0]!);
    },

    async findContacts(merchantId, query) {
      const contacts = await all(merchantId);
      const q = normalizeName(query ?? "");
      if (!q) return contacts;
      const digits = phoneDigits(query ?? "");
      return contacts.filter((c) => {
        const n = normalizeName(c.name);
        if (n.includes(q)) return true;
        if (digits.length >= 3 && phoneDigits(c.phone).includes(digits)) return true;
        return q.length >= 4 && levenshtein(q, n) <= 2;
      });
    },

    async getContactByName(merchantId, name) {
      const contacts = await all(merchantId);
      // A phone number where a name was expected: match it by digits.
      const digits = phoneDigits(name);
      if (digits.length >= 7 && /^\+?[\d\s().-]+$/.test(name.trim())) {
        const hits = contacts.filter((c) => phoneDigits(c.phone).endsWith(digits) || digits.endsWith(phoneDigits(c.phone)));
        return hits.length === 1 ? { contact: hits[0]!, suggestions: [] } : { contact: null, suggestions: hits.slice(0, 3) };
      }
      const r = matchName(name, contacts, (c) => c.name);
      return r.match ? { contact: r.match, suggestions: [] } : { contact: null, suggestions: r.suggestions };
    },
  };
}
