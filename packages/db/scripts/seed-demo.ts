// pnpm --filter @rove/db seed:demo
// Upserts the demo shops into DATABASE_URL. Idempotent.
//   ahseng (SGD): DEMO_MERCHANT (live), DEMO_MENU and DEMO_CONTACTS from @rove/shared/mocks.
//     Optional: DEMO_MERCHANT_XRPL_ADDRESS + DEMO_MERCHANT_SEED_ENC (the custodial account from the XRPL seed script,
//     seed encrypted with WALLET_ENCRYPTION_KEY) and DEMO_MERCHANT_CREDENTIAL_STATUS (none | issued | accepted).
//   cafe-berlin (EUR, country DE): DEMO_EUR_MERCHANT (live) and DEMO_EUR_MENU, only when XRPL_MERCHANT_CAFE_BERLIN_ADDRESS
//     + XRPL_MERCHANT_CAFE_BERLIN_SEED_ENC are set (pnpm seed creates the account with its trust lines and Credential).
//     XRPL_MERCHANT_CAFE_BERLIN_CREDENTIAL_STATUS optional (default accepted: the XRPL seed accepts the Credential).

import type { CredentialStatus } from "@rove/shared";
import { seedDemoData, seedEurDemoData } from "../src/demo";
import { postgresPool } from "../src/executor";
import { databaseUrl, describeUrl } from "./env";

const url = databaseUrl();
const env = (k: string) => process.env[k]?.trim() || null;

function credentialFrom(name: string): CredentialStatus | null {
  const v = env(name);
  if (v && !["none", "issued", "accepted"].includes(v)) {
    console.error(`${name} must be none | issued | accepted, got "${v}"`);
    process.exit(1);
  }
  return v as CredentialStatus | null;
}

const credential = credentialFrom("DEMO_MERCHANT_CREDENTIAL_STATUS");
const xrplAddress = env("DEMO_MERCHANT_XRPL_ADDRESS");
const xrplSeedEnc = env("DEMO_MERCHANT_SEED_ENC");
if (Boolean(xrplAddress) !== Boolean(xrplSeedEnc)) {
  console.warn("Only one of DEMO_MERCHANT_XRPL_ADDRESS / DEMO_MERCHANT_SEED_ENC is set; setting just that one.");
}
const cafeAddress = env("XRPL_MERCHANT_CAFE_BERLIN_ADDRESS");
const cafeSeedEnc = env("XRPL_MERCHANT_CAFE_BERLIN_SEED_ENC");
const cafeCredential = credentialFrom("XRPL_MERCHANT_CAFE_BERLIN_CREDENTIAL_STATUS") ?? "accepted";

const pool = postgresPool(url, { max: 1 });
try {
  const r = await seedDemoData(pool, { xrplAddress, xrplSeedEnc, credentialStatus: credential });
  console.log(
    `demo data upserted on ${describeUrl(url)}: merchant "${r.merchantId}" (live), ${r.menuItems} menu items, ${r.contacts} contact(s)` +
      (xrplAddress ? `, XRPL account ${xrplAddress}` : ""),
  );
  if (cafeAddress && cafeSeedEnc) {
    const c = await seedEurDemoData(pool, { xrplAddress: cafeAddress, xrplSeedEnc: cafeSeedEnc, credentialStatus: cafeCredential });
    console.log(`demo data upserted: merchant "${c.merchantId}" (live, EUR, DE), ${c.menuItems} menu items, XRPL account ${cafeAddress}`);
  } else {
    console.log("cafe-berlin skipped: XRPL_MERCHANT_CAFE_BERLIN_ADDRESS / XRPL_MERCHANT_CAFE_BERLIN_SEED_ENC not set (run pnpm seed first)");
  }
} catch (e) {
  console.error("seed:demo failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
