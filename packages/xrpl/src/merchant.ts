// Merchant custodial accounts + verification (NI-A4). Spec: settlement-xrpl.md §5.
// Every step checks the ledger first, so calling createMerchantAccount again for the same merchant resumes
// where it stopped (or does nothing) instead of creating a second account.

import { isValidClassicAddress, Wallet } from "xrpl";
import type { EngineContext } from "./context";
import { encryptSeed } from "./crypto";
import { VERIFIED_MERCHANT_CREDENTIAL } from "./currency";
import { XrplCredentialsUnavailableError, XrplTxError } from "./errors";
import { findLine, getAccountRoot, getCredential, getReserves, getTrustLines } from "./ledger";
import { submitTx } from "./submit";
import { buildCredentialAccept, buildCredentialCreate, buildTrustSet, buildXrpPayment, LSF_ACCEPTED } from "./tx";

/** At least 3 XRP: the base reserve, 2 trust lines + the Credential (owner reserves), and fees. */
export const MIN_MERCHANT_FUNDING_DROPS = 3_000_000n;
const FEE_BUFFER_DROPS = 1_000_000n;

/** Drops to send a new merchant account given the network's reserves. */
export function merchantFundingDrops(reserves: { baseDrops: bigint; incDrops: bigint }): bigint {
  const needed = reserves.baseDrops + 3n * reserves.incDrops + FEE_BUFFER_DROPS;
  return needed > MIN_MERCHANT_FUNDING_DROPS ? needed : MIN_MERCHANT_FUNDING_DROPS;
}

export interface CreateMerchantResult {
  xrplAddress: string;
  credentialStatus: "issued" | "accepted";
}

export async function createMerchantAccount(ctx: EngineContext, merchantId: string): Promise<CreateMerchantResult> {
  if (!merchantId) throw new Error("createMerchantAccount: merchantId is required");
  const store = ctx.seedStore;
  if (!store) throw new Error("createMerchantAccount needs a SeedStore (the worker wires it to the DB)");
  if (!ctx.config.walletEncryptionKey) throw new Error("createMerchantAccount needs WALLET_ENCRYPTION_KEY to encrypt the seed");
  const sgd = ctx.sgd();
  const usd = ctx.usd();
  const treasury = ctx.treasuryWallet();
  const credIssuer = ctx.credentialIssuerAddress();

  // 1. Reuse the merchant's existing account, or generate one and persist it BEFORE any funds move.
  let wallet: Wallet;
  const existing = store.findByMerchant ? await store.findByMerchant(merchantId) : null;
  if (existing) {
    wallet = await ctx.merchantWallet(existing);
  } else {
    wallet = Wallet.generate();
    await store.put(merchantId, wallet.address, encryptSeed(wallet.seed as string, ctx.config.walletEncryptionKey));
  }
  const address = wallet.address;

  // 2. Fund from the treasury (creates the account).
  if (!(await getAccountRoot(ctx.conn, address))) {
    const drops = merchantFundingDrops(await getReserves(ctx.conn));
    await submitTx(ctx, treasury, buildXrpPayment({ account: treasury.address, destination: address, drops: drops.toString() }), {
      label: `fund merchant ${merchantId}`,
    });
  }

  // 3. Trust lines to the XSGD and RLUSD issuers.
  const lines = await getTrustLines(ctx.conn, address);
  for (const asset of [sgd, usd]) {
    if (findLine(lines, asset.currency, asset.issuer)) continue;
    await submitTx(ctx, wallet, buildTrustSet({ account: address, currency: asset.currency, issuer: asset.issuer }), {
      label: `trust line ${merchantId} → ${asset.issuer === sgd.issuer ? "XSGD" : "RLUSD"}`,
    });
  }

  // 4. Credential: CRED_ISSUER creates, the merchant accepts.
  const q = { subject: address, issuer: credIssuer, credentialType: VERIFIED_MERCHANT_CREDENTIAL };
  let cred = await getCredential(ctx.conn, q);
  if (!cred) {
    const issuerWallet = ctx.credentialIssuerWallet();
    try {
      await submitTx(ctx, issuerWallet, buildCredentialCreate({ issuer: issuerWallet.address, subject: address, credentialType: VERIFIED_MERCHANT_CREDENTIAL }), {
        label: `CredentialCreate ${merchantId}`,
        accept: ["tecDUPLICATE"],
      });
    } catch (err) {
      if (err instanceof XrplTxError && (err.code === "temDISABLED" || err.code === "temUNKNOWN")) {
        throw new XrplCredentialsUnavailableError(
          `Credentials are not enabled on this network (${err.code}); account ${address} is set up without a Credential`,
          address,
        );
      }
      throw err;
    }
    cred = await getCredential(ctx.conn, q);
    if (!cred) throw new Error(`CredentialCreate for ${address} validated but the Credential isn't on the ledger yet`);
  }
  if ((cred.flags & LSF_ACCEPTED) === 0) {
    await submitTx(ctx, wallet, buildCredentialAccept({ subject: address, issuer: credIssuer, credentialType: VERIFIED_MERCHANT_CREDENTIAL }), {
      label: `CredentialAccept ${merchantId}`,
      accept: ["tecDUPLICATE"],
    });
    cred = await getCredential(ctx.conn, q);
  }
  const accepted = cred !== null && (cred.flags & LSF_ACCEPTED) !== 0;
  return { xrplAddress: address, credentialStatus: accepted ? "accepted" : "issued" };
}

/** ROVE_VERIFIED_MERCHANT Credential exists for `address` from our issuer and is accepted. Read-only. */
export async function isVerifiedMerchant(ctx: EngineContext, address: string): Promise<boolean> {
  if (!isValidClassicAddress(address)) return false;
  const cred = await getCredential(ctx.conn, {
    subject: address,
    issuer: ctx.credentialIssuerAddress(),
    credentialType: VERIFIED_MERCHANT_CREDENTIAL,
  });
  return cred !== null && (cred.flags & LSF_ACCEPTED) !== 0;
}
