// POST /internal/merchants: onboarding's last step. Owner: Nithya · Task: NI-C1.
// Custodial XRPL account (+ trust lines + Credential, inside settlement.createMerchantAccount) → status live → merchant.live.
//
// Idempotent on merchant id:
//   - already live → return the stored account, no new account, no second merchant.live
//   - draft that already has an XRPL address (an earlier call got that far) → reuse it, never create a second account
//   - concurrent calls for the same id share one in-flight run (single worker process)

import type { Merchant, MerchantId } from "@rove/shared";
import type { InternalCreateMerchantReq, InternalCreateMerchantRes } from "./contracts";
import type { WorkerDeps } from "./deps";
import { UserFacingError } from "./errors";

/** Stored in place of a seed for mock-engine accounts (they have no key). The real engine always stores one. */
export const MOCK_SEED_PLACEHOLDER = "mock:no-seed";

const inFlight = new Map<MerchantId, Promise<InternalCreateMerchantRes>>();

export function createMerchant(deps: WorkerDeps, body: InternalCreateMerchantReq): Promise<InternalCreateMerchantRes> {
  const running = inFlight.get(body.id);
  if (running) return running;
  const run = provision(deps, body).finally(() => inFlight.delete(body.id));
  inFlight.set(body.id, run);
  return run;
}

function toRes(m: Merchant, log: WorkerDeps["log"]): InternalCreateMerchantRes {
  if (!m.xrplAddress) throw new Error(`merchant ${m.id} is live without an XRPL address`);
  let credentialStatus = m.credentialStatus;
  if (credentialStatus === "none") {
    log.warn("live merchant has no recorded credential status; reporting issued", { merchantId: m.id });
    credentialStatus = "issued";
  }
  return { merchantId: m.id, xrplAddress: m.xrplAddress, credentialStatus };
}

async function provision(deps: WorkerDeps, body: InternalCreateMerchantReq): Promise<InternalCreateMerchantRes> {
  const { db, settlement } = deps;
  const log = deps.log.child("merchants");

  const existing = await db.getMerchant(body.id);
  if (existing && existing.phone !== body.phone) {
    throw new UserFacingError("shop_id_taken", "That shop code is already taken. Pick a different one.", 409);
  }
  if (existing?.status === "live") {
    log.info("merchant already live", { merchantId: body.id });
    return toRes(existing, log);
  }

  // Onboarding normally created the draft before the setup card; this also covers a direct call.
  const draft = await db.upsertDraftMerchant({
    id: body.id,
    name: body.name,
    phone: body.phone,
    channel: body.channel,
    category: body.category,
    currency: body.currency,
  });

  let xrplAddress = draft.xrplAddress;
  let credentialStatus: "issued" | "accepted";
  if (!xrplAddress) {
    log.info("creating custodial XRPL account", { merchantId: body.id });
    const account = await settlement.createMerchantAccount({ merchantId: body.id });
    xrplAddress = account.xrplAddress;
    credentialStatus = account.credentialStatus;
  } else if (draft.credentialStatus === "none") {
    // An earlier run created the account but stopped before recording the Credential. Don't make a second account.
    credentialStatus = (await settlement.isVerifiedMerchant(xrplAddress)) ? "accepted" : "issued";
    log.warn("reusing XRPL account from an earlier attempt", { merchantId: body.id, xrplAddress, credentialStatus });
  } else {
    credentialStatus = draft.credentialStatus;
  }

  if (draft.xrplAddress !== xrplAddress || draft.credentialStatus !== credentialStatus) {
    // The real engine stored the encrypted seed through the SeedStore (deps.ts) while creating the account.
    const seedEnc = await db.getMerchantSeedEnc(xrplAddress);
    if (!seedEnc && !deps.config.useMockSettlement) {
      throw new Error(`no encrypted seed stored for ${xrplAddress} (merchant ${body.id}); refusing to go live without the key`);
    }
    await db.setMerchantXrpl(body.id, { xrplAddress, xrplSeedEnc: seedEnc ?? MOCK_SEED_PLACEHOLDER, credentialStatus });
  }

  const live = await db.setMerchantLive(body.id);
  if (!live) {
    // CAS lost: someone else flipped it to live (and emitted). Report what's stored.
    const now = await db.getMerchant(body.id);
    if (now?.status === "live") return toRes(now, log);
    throw new Error(`merchant ${body.id} could not be set live (status ${now?.status ?? "missing"})`);
  }

  await deps.emit({ type: "merchant.live", merchantId: body.id, xrplAddress });
  log.info("merchant live", { merchantId: body.id, xrplAddress, credentialStatus });
  return { merchantId: body.id, xrplAddress, credentialStatus };
}
