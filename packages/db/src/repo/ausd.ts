// AUSD lane (docs/specs/ausd-lane.md): the payer's signed ERC-3009 TransferWithAuthorization stored on the payment, and the
// worker relayer's bookkeeping. uint256 values are decimal integer strings in and out (numeric(78,0) in the DB, never floats).

import type { Payment } from "@rove/shared";
import { DbConflictError } from "../errors";
import type { Executor, Param, Pool, Row } from "../executor";
import type { AusdAuthorization, AusdRelayState, Db, SetAusdAuthorizationResult } from "../index";
import { PAYMENT_COLS, toPayment } from "../map";
import { paymentsRepo } from "./payments";

type AusdRepo = Pick<
  Db,
  "setAusdAuthorization" | "insertAusdPayment" | "getAusdRelay" | "getPaymentByAusdNonce" | "listAusdAwaitingRelay" | "setAusdRelayTx"
>;

const AUSD_COLS =
  "ausd_from, ausd_to, ausd_value::text as ausd_value, ausd_valid_after::text as ausd_valid_after, " +
  "ausd_valid_before::text as ausd_valid_before, ausd_nonce, ausd_signature, ausd_relay_tx_hash, ausd_relay_attempts, payin_tx_hash, failure_reason";
const COLS = `${PAYMENT_COLS}, ${AUSD_COLS}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const UINT_RE = /^\d{1,78}$/;

/** Validates an authorization before it reaches the DB (shape only; the web verifies the signature). */
function check(a: AusdAuthorization): AusdAuthorization {
  const bad = (field: string) => new Error(`@rove/db: invalid AUSD authorization ${field}`);
  if (!ADDRESS_RE.test(a.from)) throw bad("from");
  if (!ADDRESS_RE.test(a.to)) throw bad("to");
  for (const [k, v] of [["value", a.value], ["validAfter", a.validAfter], ["validBefore", a.validBefore]] as const) {
    if (!UINT_RE.test(v)) throw bad(k);
  }
  if (!BYTES32_RE.test(a.nonce)) throw bad("nonce");
  if (!SIGNATURE_RE.test(a.signature)) throw bad("signature");
  // Strip leading zeros so equality checks compare numbers, not spellings.
  const uint = (v: string) => BigInt(v).toString();
  return { ...a, value: uint(a.value), validAfter: uint(a.validAfter), validBefore: uint(a.validBefore) };
}

function sameAuthorization(a: AusdAuthorization, b: AusdAuthorization): boolean {
  const lc = (s: string) => s.toLowerCase();
  return (
    lc(a.from) === lc(b.from) &&
    lc(a.to) === lc(b.to) &&
    a.value === b.value &&
    a.validAfter === b.validAfter &&
    a.validBefore === b.validBefore &&
    lc(a.nonce) === lc(b.nonce) &&
    lc(a.signature) === lc(b.signature)
  );
}

function toAuthorization(r: Row): AusdAuthorization | null {
  if (r.ausd_signature == null) return null;
  return {
    from: String(r.ausd_from),
    to: String(r.ausd_to),
    value: String(r.ausd_value),
    validAfter: String(r.ausd_valid_after),
    validBefore: String(r.ausd_valid_before),
    nonce: String(r.ausd_nonce),
    signature: String(r.ausd_signature),
  };
}

function toRelayState(r: Row): AusdRelayState | null {
  const authorization = toAuthorization(r);
  if (!authorization) return null;
  return {
    payment: toPayment(r),
    authorization,
    relayTxHash: r.ausd_relay_tx_hash == null ? null : String(r.ausd_relay_tx_hash),
    relayAttempts: Number(r.ausd_relay_attempts ?? 0),
    payinTxHash: r.payin_tx_hash == null ? null : String(r.payin_tx_hash),
    failureReason: r.failure_reason == null ? null : String(r.failure_reason),
  };
}

const SET_AUTH = `ausd_from = $2, ausd_to = $3, ausd_value = $4::numeric, ausd_valid_after = $5::numeric, ausd_valid_before = $6::numeric,
  ausd_nonce = $7, ausd_signature = $8, updated_at = now()`;
const authParams = (id: string, a: AusdAuthorization): Param[] => [id, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.signature];

/** An executor that also looks like a Pool, so a repo can run inside someone else's transaction. */
function asPool(q: Executor): Pool {
  return { query: (text, params) => q.query(text, params), tx: (fn) => fn(q), end: async () => {} };
}

export function ausdRepo(pool: Pool): AusdRepo {
  const getRow = async (q: Executor, id: string) => (await q.query(`select ${COLS} from payments where id = $1`, [id]))[0] ?? null;

  return {
    async setAusdAuthorization(paymentId, input): Promise<SetAusdAuthorizationResult> {
      const a = check(input);
      let rows: Row[];
      try {
        rows = await pool.query(
          `update payments set ${SET_AUTH}
            where id = $1 and method = 'ausd' and status = 'created' and ausd_signature is null returning ${PAYMENT_COLS}`,
          authParams(paymentId, a),
        );
      } catch (e) {
        // The same (from, nonce) already pays another payment.
        if (e instanceof DbConflictError && e.constraint === "payments_ausd_nonce") {
          const row = await getRow(pool, paymentId);
          return { ok: false, reason: "authorization_reused", payment: row ? toPayment(row) : null };
        }
        throw e;
      }
      if (rows[0]) return { ok: true, payment: toPayment(rows[0]), alreadyStored: false };

      const row = await getRow(pool, paymentId);
      if (!row) return { ok: false, reason: "not_found", payment: null };
      const payment = toPayment(row);
      if (payment.method !== "ausd") return { ok: false, reason: "not_ausd", payment };
      const stored = toAuthorization(row);
      // A retry of the same signed authorization is fine whatever the status has become (idempotent).
      if (stored && sameAuthorization(stored, a)) return { ok: true, payment, alreadyStored: true };
      if (stored) return { ok: false, reason: "different_authorization", payment };
      return { ok: false, reason: "not_created", payment };
    },

    async insertAusdPayment(p, input) {
      if (p.method !== "ausd") throw new Error(`@rove/db: insertAusdPayment needs method "ausd", got ${p.method}`);
      const a = check(input);
      return pool.tx(async (q) => {
        const payment = await paymentsRepo(asPool(q)).insertPayment(p);
        const rows = await q.query(`update payments set ${SET_AUTH} where id = $1 returning ${PAYMENT_COLS}`, authParams(payment.id, a));
        return toPayment(rows[0]!);
      });
    },

    async getAusdRelay(paymentId) {
      const row = await getRow(pool, paymentId);
      return row ? toRelayState(row) : null;
    },

    async getPaymentByAusdNonce(from, nonce): Promise<Payment | null> {
      const rows = await pool.query(
        `select ${PAYMENT_COLS} from payments where lower(ausd_from) = lower($1) and lower(ausd_nonce) = lower($2) and ausd_nonce is not null`,
        [from, nonce],
      );
      return rows[0] ? toPayment(rows[0]) : null;
    },

    async listAusdAwaitingRelay(limit = 20) {
      const rows = await pool.query(
        `select ${COLS} from payments
          where method = 'ausd' and status = 'created' and ausd_signature is not null
          order by updated_at, id limit $1`,
        [limit],
      );
      return rows.map(toRelayState).filter((s): s is AusdRelayState => s !== null);
    },

    async setAusdRelayTx(paymentId, txHash) {
      if (!BYTES32_RE.test(txHash)) throw new Error("@rove/db: invalid relay tx hash");
      const rows = await pool.query(
        `update payments set ausd_relay_tx_hash = $2, ausd_relay_attempts = ausd_relay_attempts + 1, updated_at = now()
          where id = $1 and status = 'created' and ausd_signature is not null returning id`,
        [paymentId, txHash],
      );
      return rows.length > 0;
    },
  };
}
