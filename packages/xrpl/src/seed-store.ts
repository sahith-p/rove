// Where encrypted merchant seeds live. The engine only ever sees ciphertext from here and decrypts it with
// WALLET_ENCRYPTION_KEY right before signing. The worker wires this to the DB:
//   put → db.setMerchantXrpl(merchantId, { xrplAddress, xrplSeedEnc, credentialStatus })
//   get → db.getMerchantSeedEnc(xrplAddress)
//   findByMerchant → the merchant row's xrplAddress (lets createMerchantAccount resume instead of starting over)

import { readEnvFile, upsertEnvFile } from "./envfile";

export interface SeedStore {
  /** Persist the custodial account. Called BEFORE the account is funded, so no funds ever sit behind a lost key. */
  put(merchantId: string, xrplAddress: string, seedEnc: string): Promise<void>;
  /** The encrypted seed for an address we custody, or null. */
  get(xrplAddress: string): Promise<string | null>;
  /** The address already created for this merchant, if any (makes createMerchantAccount idempotent). */
  findByMerchant?(merchantId: string): Promise<string | null>;
}

/** In-memory store for scripts and tests. */
export function memorySeedStore(): SeedStore & { size(): number } {
  const byAddress = new Map<string, string>();
  const byMerchant = new Map<string, string>();
  return {
    async put(merchantId, xrplAddress, seedEnc) {
      byAddress.set(xrplAddress, seedEnc);
      byMerchant.set(merchantId, xrplAddress);
    },
    async get(xrplAddress) {
      return byAddress.get(xrplAddress) ?? null;
    },
    async findByMerchant(merchantId) {
      return byMerchant.get(merchantId) ?? null;
    },
    size: () => byAddress.size,
  };
}

const envKeyFor = (merchantId: string) => merchantId.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * File-backed store on top of .env.seed. The demo merchant uses DEMO_MERCHANT_XRPL_ADDRESS / DEMO_MERCHANT_SEED_ENC
 * (the DB seed copies them into the merchants row); any other merchant gets XRPL_MERCHANT_<ID>_ADDRESS / _SEED_ENC.
 */
export function envFileSeedStore(path: string, opts: { demoMerchantId?: string } = {}): SeedStore {
  const demo = opts.demoMerchantId ?? "ahseng";
  const keys = (merchantId: string) =>
    merchantId === demo
      ? { address: "DEMO_MERCHANT_XRPL_ADDRESS", seed: "DEMO_MERCHANT_SEED_ENC" }
      : { address: `XRPL_MERCHANT_${envKeyFor(merchantId)}_ADDRESS`, seed: `XRPL_MERCHANT_${envKeyFor(merchantId)}_SEED_ENC` };
  return {
    async put(merchantId, xrplAddress, seedEnc) {
      const k = keys(merchantId);
      upsertEnvFile(path, { [k.address]: xrplAddress, [k.seed]: seedEnc });
    },
    async get(xrplAddress) {
      const env = readEnvFile(path);
      for (const [key, value] of Object.entries(env)) {
        if (value !== xrplAddress) continue;
        const seedKey = key === "DEMO_MERCHANT_XRPL_ADDRESS" ? "DEMO_MERCHANT_SEED_ENC" : key.replace(/_ADDRESS$/, "_SEED_ENC");
        if (seedKey !== key && env[seedKey]) return env[seedKey] as string;
      }
      return null;
    },
    async findByMerchant(merchantId) {
      return readEnvFile(path)[keys(merchantId).address] || null;
    },
  };
}
