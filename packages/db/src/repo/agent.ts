// pending actions (only plain code claims them), agent memory, onboarding, idempotency keys, event outbox

import { newId, PENDING_ACTION_TTL_MS } from "@rove/shared";
import type { Param, Pool } from "../executor";
import type { Db } from "../index";
import { ACTION_COLS, normalizePhone, toAction, toAgentMessage, toEnvelope, toOnboarding } from "../map";

type AgentRepo = Pick<
  Db,
  | "insertAction"
  | "getAction"
  | "addConfirmMessageIds"
  | "findOpenActionByMessageId"
  | "findActionByMessageId"
  | "setActionMessageIds"
  | "findActionByRef"
  | "findOpenActionsForMerchant"
  | "claimAction"
  | "setActionStatus"
  | "expireActions"
  | "appendAgentMessage"
  | "recentAgentMessages"
  | "getOnboarding"
  | "setOnboarding"
  | "claim"
  | "insertEvent"
  | "markEventDelivered"
  | "listUndeliveredEvents"
>;

/** Appends the action column list (incl. the to_jsonb'd text[]) as the statement's RETURNING clause. */
const returningAction = (sql: string) => `${sql} returning ${ACTION_COLS}`;

export function agentRepo(pool: Pool): AgentRepo {
  const actions = async (sql: string, params: Param[]) => (await pool.query(sql, params)).map(toAction);
  const action = async (sql: string, params: Param[]) => (await actions(sql, params))[0] ?? null;

  return {
    // ---------------------------------------------------------------- pending actions

    async insertAction(a) {
      const row = await action(
        returningAction(
          `insert into pending_actions (id, merchant_id, kind, args, confirm_message_ids, expires_at)
           values ($1, $2, $3, $4::text::jsonb, array(select jsonb_array_elements_text($5::text::jsonb)),
                   coalesce($6::timestamptz, now() + make_interval(secs => $7)))`,
        ),
        [
          newId("act"),
          a.merchantId,
          a.args.kind,
          JSON.stringify(a.args),
          JSON.stringify(a.confirmMessageIds ?? []),
          a.expiresAt ?? null,
          PENDING_ACTION_TTL_MS / 1000,
        ],
      );
      return row!;
    },

    getAction: (id) => action(`select ${ACTION_COLS} from pending_actions where id = $1`, [id]),

    async addConfirmMessageIds(id, messageIds) {
      await pool.query(
        `update pending_actions
            set confirm_message_ids = confirm_message_ids ||
                array(select m from jsonb_array_elements_text($2::text::jsonb) m where m <> all(confirm_message_ids))
          where id = $1`,
        [id, JSON.stringify([...new Set(messageIds)])],
      );
    },

    findOpenActionByMessageId: (messageId) =>
      action(
        `select ${ACTION_COLS} from pending_actions
          where status = 'proposed' and expires_at > now() and $1 = any(confirm_message_ids)
          order by created_at desc limit 1`,
        [messageId],
      ),

    async setActionMessageIds(id, messageIds) {
      await pool.query(
        `update pending_actions set confirm_message_ids = array(select jsonb_array_elements_text($2::text::jsonb)) where id = $1`,
        [id, JSON.stringify([...new Set(messageIds)])],
      );
    },

    findActionByMessageId: (messageId) =>
      action(
        `select ${ACTION_COLS} from pending_actions where $1 = any(confirm_message_ids) order by created_at desc limit 1`,
        [messageId],
      ),

    findActionByRef: (ref) =>
      action(
        `select ${ACTION_COLS} from pending_actions
          where args->>'withdrawalId' = $1 or args->>'paymentId' = $1
          order by created_at desc limit 1`,
        [ref],
      ),

    findOpenActionsForMerchant: (merchantId) =>
      actions(
        `select ${ACTION_COLS} from pending_actions
          where merchant_id = $1 and status = 'proposed' and expires_at > now() order by created_at desc, id`,
        [merchantId],
      ),

    claimAction: (id) =>
      action(
        returningAction(`update pending_actions set status = 'executing' where id = $1 and status = 'proposed' and expires_at > now()`),
        [id],
      ),

    setActionStatus: (id, status, result) =>
      action(
        returningAction(
          `update pending_actions set
             status = $2,
             result = coalesce($3::text::jsonb, result),
             executed_at = case when $2 in ('done', 'failed') then coalesce(executed_at, now()) else executed_at end
           where id = $1`,
        ),
        [id, status, result === undefined ? null : JSON.stringify(result)],
      ),

    expireActions: (now) =>
      actions(
        returningAction(`update pending_actions set status = 'expired' where status = 'proposed' and expires_at <= coalesce($1::timestamptz, now())`),
        [now ? now.toISOString() : null],
      ),

    // ---------------------------------------------------------------- agent memory + onboarding

    async appendAgentMessage(m) {
      await pool.query(
        `insert into agent_messages (phone, persona, merchant_id, role, content, channel) values ($1, $2, $3, $4, $5, $6)`,
        [normalizePhone(m.phone), m.persona, m.merchantId, m.role, m.content, m.channel],
      );
    },

    async recentAgentMessages(phone, limit) {
      const rows = await pool.query(
        `select phone, persona, merchant_id, role, content, channel, created_at from (
           select * from agent_messages where phone = $1 order by id desc limit $2
         ) recent order by id`,
        [normalizePhone(phone), Math.max(0, Math.floor(limit))],
      );
      return rows.map(toAgentMessage);
    },

    async getOnboarding(phone) {
      const rows = await pool.query(`select phone, channel, step, data, updated_at from onboarding where phone = $1`, [normalizePhone(phone)]);
      return rows[0] ? toOnboarding(rows[0]) : null;
    },

    async setOnboarding(phone, channel, step, data) {
      await pool.query(
        `insert into onboarding (phone, channel, step, data, updated_at) values ($1, $2, $3, $4::text::jsonb, now())
         on conflict (phone) do update set channel = excluded.channel, step = excluded.step, data = excluded.data, updated_at = now()`,
        [normalizePhone(phone), channel, step, JSON.stringify(data)],
      );
    },

    // ---------------------------------------------------------------- plumbing

    async claim(key) {
      const [row] = await pool.query<{ ok: boolean }>(`select claim($1) as ok`, [key]);
      return row?.ok === true;
    },

    async insertEvent(envelope) {
      await pool.query(`insert into events (id, type, payload, at) values ($1, $2, $3::text::jsonb, $4::timestamptz) on conflict (id) do nothing`, [
        envelope.id,
        envelope.event.type,
        JSON.stringify(envelope.event),
        envelope.at,
      ]);
    },

    async markEventDelivered(id) {
      await pool.query(`update events set delivered_at = now() where id = $1 and delivered_at is null`, [id]);
    },

    async listUndeliveredEvents(limit = 100) {
      const rows = await pool.query(`select id, at, payload from events where delivered_at is null order by at, id limit $1`, [limit]);
      return rows.map(toEnvelope);
    },
  };
}
