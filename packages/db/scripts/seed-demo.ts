// pnpm --filter @rove/db seed:demo
// Upserts DEMO_MERCHANT (live), DEMO_MENU and DEMO_CONTACTS from @rove/shared/mocks into DATABASE_URL. Idempotent.
// Optional: DEMO_MERCHANT_XRPL_ADDRESS + DEMO_MERCHANT_SEED_ENC (the custodial account from the XRPL seed script,
// seed encrypted with WALLET_ENCRYPTION_KEY) and DEMO_MERCHANT_CREDENTIAL_STATUS (none | issued | accepted).

import type { CredentialStatus } from "@rove/shared";
import { seedDemoData } from "../src/demo";
import { postgresPool } from "../src/executor";
import { databaseUrl, describeUrl } from "./env";

const url = databaseUrl();
const env = (k: string) => process.env[k]?.trim() || null;

const credential = env("DEMO_MERCHANT_CREDENTIAL_STATUS");
if (credential && !["none", "issued", "accepted"].includes(credential)) {
  console.error(`DEMO_MERCHANT_CREDENTIAL_STATUS must be none | issued | accepted, got "${credential}"`);
  process.exit(1);
}
const xrplAddress = env("DEMO_MERCHANT_XRPL_ADDRESS");
const xrplSeedEnc = env("DEMO_MERCHANT_SEED_ENC");
if (Boolean(xrplAddress) !== Boolean(xrplSeedEnc)) {
  console.warn("Only one of DEMO_MERCHANT_XRPL_ADDRESS / DEMO_MERCHANT_SEED_ENC is set; setting just that one.");
}

const pool = postgresPool(url, { max: 1 });
try {
  const r = await seedDemoData(pool, { xrplAddress, xrplSeedEnc, credentialStatus: credential as CredentialStatus | null });
  console.log(
    `demo data upserted on ${describeUrl(url)}: merchant "${r.merchantId}" (live), ${r.menuItems} menu items, ${r.contacts} contact(s)` +
      (xrplAddress ? `, XRPL account ${xrplAddress}` : ""),
  );
} catch (e) {
  console.error("seed:demo failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
