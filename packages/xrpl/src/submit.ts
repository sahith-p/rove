// Sign + submit + wait for validation, one in flight per signer (queue.ts).
// - tefPAST_SEQ / tefMAX_LEDGER / tel* (fee spikes) → re-autofill and resubmit inside the same queue slot.
// - A resubmit after a dropped socket reuses the same signed blob (same hash), so it can't double-apply.
// - The final answer is the validated meta.TransactionResult; anything but tesSUCCESS throws a typed error.

import type { SubmittableTransaction, TransactionMetadata, Wallet } from "xrpl";
import { isConnectionError, rippledErrorCode, type XrplConnection } from "./client";
import { txErrorFor, XrplTxError } from "./errors";
import type { SubmitQueue } from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TxOutcome {
  hash: string;
  ledgerIndex: number;
  /** meta.TransactionResult */
  result: string;
  meta: TransactionMetadata;
  tx: Record<string, unknown>;
}

export interface SubmitDeps {
  conn: XrplConnection;
  queue: SubmitQueue;
  log: (line: string) => void;
  explorerUrl: (hash: string) => string;
  /** Called for every tx this process gets validated with a success result (not for dedupe hits). */
  onTx?: (label: string, outcome: TxOutcome) => void;
}

export interface SubmitOptions {
  /** Human label for logs and errors, e.g. "settle pay_123". */
  label: string;
  /** Runs inside the signer's queue slot before submitting; return a prior outcome to skip (idempotency). */
  dedupe?: () => Promise<TxOutcome | null>;
  /** Extra final results to treat as success (e.g. "tecDUPLICATE" for an idempotent create). */
  accept?: string[];
  /** Resubmission attempts for stale sequence / expired / local errors. Default 4. */
  attempts?: number;
}

const RESUBMIT_PRELIM = new Set(["tefPAST_SEQ", "tefMAX_LEDGER", "terPRE_SEQ", "tefALREADY"]);

export async function submitTx(deps: SubmitDeps, wallet: Wallet, tx: object, opts: SubmitOptions): Promise<TxOutcome> {
  return deps.queue.run(wallet.address, async () => {
    if (opts.dedupe) {
      const prior = await opts.dedupe();
      if (prior) {
        deps.log(`${opts.label}: already on ledger (${prior.result}) ${deps.explorerUrl(prior.hash)}`);
        return prior;
      }
    }
    const attempts = opts.attempts ?? 4;
    let lastProblem = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt);
      const prepared = await deps.conn.run((c) => c.autofill(tx as unknown as SubmittableTransaction));
      const signed = wallet.sign(prepared);
      const lastLedger = prepared.LastLedgerSequence ?? Number.MAX_SAFE_INTEGER;

      let prelim: string;
      try {
        const sub = await deps.conn.run((c) => c.request({ command: "submit", tx_blob: signed.tx_blob }));
        prelim = sub.result.engine_result;
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        prelim = "UNKNOWN"; // may or may not have reached the server; the hash tells us
      }

      if (prelim.startsWith("tem")) throw txErrorFor(prelim, opts.label);
      if (prelim.startsWith("tel")) {
        lastProblem = prelim; // e.g. telINSUF_FEE_P under load: wait, re-autofill, retry
        continue;
      }
      if (RESUBMIT_PRELIM.has(prelim)) {
        // Our own earlier submission of this exact blob may already be in (a retried submit after a dropped socket).
        const found = await lookupTx(deps.conn, signed.hash);
        if (!found) {
          lastProblem = prelim;
          continue;
        }
      } else if (prelim.startsWith("tef")) {
        throw txErrorFor(prelim, opts.label);
      }

      const final = await waitForValidation(deps.conn, signed.hash, lastLedger);
      if (!final) {
        lastProblem = `EXPIRED (preliminary ${prelim})`; // LastLedgerSequence passed: definitely not applied
        continue;
      }
      if (final.result === "tesSUCCESS" || opts.accept?.includes(final.result)) {
        deps.log(`${opts.label}: ${final.result} ${deps.explorerUrl(final.hash)}`);
        deps.onTx?.(opts.label, final);
        return final;
      }
      deps.log(`${opts.label}: ${final.result} ${deps.explorerUrl(final.hash)}`);
      throw txErrorFor(final.result, opts.label, final.hash);
    }
    throw new XrplTxError(lastProblem.split(" ")[0] || "SUBMIT_FAILED", `${opts.label}: not applied after ${attempts} attempts (${lastProblem})`, {
      retryable: true,
    });
  });
}

function toOutcome(result: Record<string, unknown>): TxOutcome | null {
  const meta = result.meta as TransactionMetadata | string | undefined;
  if (!meta || typeof meta === "string") return null;
  const tx = (result.tx_json ?? result.tx ?? result) as Record<string, unknown>;
  return {
    hash: String(result.hash ?? tx.hash ?? ""),
    ledgerIndex: Number(result.ledger_index ?? tx.ledger_index ?? 0),
    result: meta.TransactionResult,
    meta,
    tx,
  };
}

/** A validated tx by hash, or null if the server doesn't know it (yet). */
export async function lookupTx(conn: XrplConnection, hash: string): Promise<TxOutcome | null> {
  try {
    const r = await conn.run((c) => c.request({ command: "tx", transaction: hash }));
    const res = r.result as unknown as Record<string, unknown>;
    return res.validated ? toOutcome(res) : null;
  } catch (err) {
    if (rippledErrorCode(err) === "txnNotFound") return null;
    throw err;
  }
}

/** Poll until validated (→ outcome) or the validated ledger passes LastLedgerSequence (→ null). */
async function waitForValidation(conn: XrplConnection, hash: string, lastLedger: number): Promise<TxOutcome | null> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    await sleep(1000);
    try {
      const found = await lookupTx(conn, hash);
      if (found) return found;
      const validated = await conn.run((c) => c.getLedgerIndex());
      if (validated > lastLedger) {
        return await lookupTx(conn, hash); // last look: it may have landed in the final ledger
      }
    } catch (err) {
      if (!isConnectionError(err)) throw err;
    }
    if (Date.now() > deadline) {
      throw new XrplTxError("TIMEOUT", `tx ${hash}: no validated result after 180s; check the explorer before retrying`);
    }
  }
}

export { toOutcome as txOutcomeFromResult };
