// Read-only ledger queries (no seeds needed). Used by the engine, the seed script and the read-only web app.

import { xrpToDrops } from "xrpl";
import { rippledErrorCode, type XrplConnection } from "./client";
import { credentialTypeHex, type IssuedAmount } from "./currency";
import { txOutcomeFromResult, type TxOutcome } from "./submit";

export interface AccountRootInfo {
  address: string;
  balanceDrops: bigint;
  flags: number;
  ownerCount: number;
  sequence: number;
}

/** account_info, or null if the account doesn't exist (actNotFound). */
export async function getAccountRoot(conn: XrplConnection, address: string): Promise<AccountRootInfo | null> {
  try {
    const r = await conn.run((c) => c.request({ command: "account_info", account: address, ledger_index: "validated" }));
    const a = r.result.account_data;
    return {
      address,
      balanceDrops: BigInt(a.Balance),
      flags: a.Flags,
      ownerCount: a.OwnerCount,
      sequence: a.Sequence,
    };
  } catch (err) {
    if (rippledErrorCode(err) === "actNotFound") return null;
    throw err;
  }
}

export interface TrustLineInfo {
  /** The counterparty (the issuer, for a holder's line). */
  account: string;
  /** From the queried account's side: positive = it holds tokens. */
  balance: string;
  currency: string;
  limit: string;
  limitPeer: string;
}

/** All trust lines of `account` (optionally only with `peer`), across pages. [] if the account doesn't exist. */
export async function getTrustLines(conn: XrplConnection, account: string, peer?: string): Promise<TrustLineInfo[]> {
  const out: TrustLineInfo[] = [];
  let marker: unknown;
  try {
    do {
      const r = await conn.run((c) =>
        c.request({
          command: "account_lines",
          account,
          ledger_index: "validated",
          limit: 400,
          ...(peer ? { peer } : {}),
          ...(marker ? { marker } : {}),
        }),
      );
      for (const l of r.result.lines) {
        out.push({ account: l.account, balance: l.balance, currency: l.currency, limit: l.limit, limitPeer: l.limit_peer });
      }
      marker = r.result.marker;
    } while (marker);
  } catch (err) {
    if (rippledErrorCode(err) === "actNotFound") return [];
    throw err;
  }
  return out;
}

export function findLine(lines: TrustLineInfo[], currencyHexCode: string, issuer: string): TrustLineInfo | undefined {
  return lines.find((l) => l.currency === currencyHexCode && l.account === issuer);
}

/** Reserve requirements from server_info, in drops. */
export async function getReserves(conn: XrplConnection): Promise<{ baseDrops: bigint; incDrops: bigint }> {
  const r = await conn.run((c) => c.request({ command: "server_info" }));
  const v = r.result.info.validated_ledger;
  if (!v) throw new Error("server_info: no validated ledger yet");
  return { baseDrops: BigInt(xrpToDrops(String(v.reserve_base_xrp))), incDrops: BigInt(xrpToDrops(String(v.reserve_inc_xrp))) };
}

export interface AmmPool {
  account: string;
  amount: IssuedAmount;
  amount2: IssuedAmount;
  /** 1/100,000 units (30 = 0.03%). */
  tradingFee: number;
}

/** amm_info for the pair, or null if there's no pool. `amount` is reported for `asset`, `amount2` for `asset2`. */
export async function getAmm(
  conn: XrplConnection,
  asset: { currency: string; issuer: string },
  asset2: { currency: string; issuer: string },
): Promise<AmmPool | null> {
  try {
    const r = await conn.run((c) => c.request({ command: "amm_info", asset, asset2, ledger_index: "validated" }));
    const amm = r.result.amm;
    if (typeof amm.amount === "string" || typeof amm.amount2 === "string") throw new Error("amm_info: XRP pools not supported");
    // rippled reports the pool's assets in its own order; line them up with the request.
    const [a, b] = amm.amount.currency === asset.currency && amm.amount.issuer === asset.issuer ? [amm.amount, amm.amount2] : [amm.amount2, amm.amount];
    return {
      account: amm.account,
      amount: { currency: a.currency, issuer: a.issuer, value: a.value },
      amount2: { currency: b.currency, issuer: b.issuer, value: b.value },
      tradingFee: amm.trading_fee,
    };
  } catch (err) {
    const code = rippledErrorCode(err);
    if (code === "actNotFound" || code === "ammNotFound" || code === "entryNotFound") return null;
    throw err;
  }
}

export interface CredentialEntry {
  flags: number;
  issuer: string;
  subject: string;
  credentialType: string;
}

/** The Credential ledger entry (subject, issuer, type), or null if there is none. */
export async function getCredential(
  conn: XrplConnection,
  q: { subject: string; issuer: string; credentialType: string },
): Promise<CredentialEntry | null> {
  const typeHex = credentialTypeHex(q.credentialType);
  try {
    const r = await conn.run((c) =>
      c.request({
        command: "ledger_entry",
        // rippled's field name is credential_type (xrpl.js types say credentialType), hence the cast.
        credential: { subject: q.subject, issuer: q.issuer, credential_type: typeHex } as unknown as {
          subject: string;
          issuer: string;
          credentialType: string;
        },
        ledger_index: "validated",
      }),
    );
    const node = r.result.node as unknown as Record<string, unknown> | undefined;
    if (!node) return null;
    return {
      flags: Number(node.Flags ?? 0),
      issuer: String(node.Issuer),
      subject: String(node.Subject),
      credentialType: String(node.CredentialType),
    };
  } catch (err) {
    const code = rippledErrorCode(err);
    if (code === "entryNotFound" || code === "actNotFound") return null;
    if (code === "invalidParams" || code === "malformedRequest" || code === "unknownOption") {
      return findCredentialViaAccountObjects(conn, q.subject, q.issuer, typeHex);
    }
    throw err;
  }
}

async function findCredentialViaAccountObjects(conn: XrplConnection, subject: string, issuer: string, typeHex: string): Promise<CredentialEntry | null> {
  try {
    const r = await conn.run((c) =>
      c.request({ command: "account_objects", account: subject, type: "credential", ledger_index: "validated", limit: 400 }),
    );
    for (const o of r.result.account_objects as unknown as Record<string, unknown>[]) {
      if (o.Issuer === issuer && o.CredentialType === typeHex) {
        return { flags: Number(o.Flags ?? 0), issuer, subject, credentialType: typeHex };
      }
    }
    return null;
  } catch (err) {
    if (rippledErrorCode(err) === "actNotFound") return null;
    throw err;
  }
}

/**
 * The most recent validated tesSUCCESS Payment from `account` with this InvoiceID (and destination, if given),
 * scanning the account's recent history. Makes settle / sweep / sendToWallet idempotent per id.
 */
export async function findPaymentByInvoiceId(
  conn: XrplConnection,
  q: { account: string; invoiceId: string; destination?: string; maxTxs?: number },
): Promise<TxOutcome | null> {
  const maxTxs = q.maxTxs ?? 400;
  let seen = 0;
  let marker: unknown;
  try {
    do {
      const r = await conn.run((c) =>
        c.request({
          command: "account_tx",
          account: q.account,
          ledger_index_min: -1,
          ledger_index_max: -1,
          limit: 200,
          forward: false,
          ...(marker ? { marker } : {}),
        }),
      );
      for (const entry of r.result.transactions as unknown as Record<string, unknown>[]) {
        seen++;
        const tx = (entry.tx_json ?? entry.tx) as Record<string, unknown> | undefined;
        if (!tx || !entry.validated) continue;
        if (tx.TransactionType !== "Payment" || tx.Account !== q.account || tx.InvoiceID !== q.invoiceId) continue;
        if (q.destination && tx.Destination !== q.destination) continue;
        const outcome = txOutcomeFromResult({ ...entry, tx_json: tx, hash: entry.hash ?? tx.hash });
        if (outcome?.result === "tesSUCCESS") return outcome;
      }
      marker = r.result.marker;
    } while (marker && seen < maxTxs);
  } catch (err) {
    if (rippledErrorCode(err) === "actNotFound") return null;
    throw err;
  }
  return null;
}
