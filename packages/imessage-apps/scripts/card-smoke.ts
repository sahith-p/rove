// Gate G2 smoke test. Owner: Sahith (SH-B4). Spec: docs/specs/imessage-apps.md §7
//   pnpm --filter @rove/imessage-apps card-smoke
// 1. Spectrum({ providers: [imessage.config()] })
// 2. presenter.send(merchant, builders.setup({ merchant, menu: [], sessionToken }))
// 3. wait 5s  4. presenter.update(merchant, builders.setup({ ..., menu: DEMO_MENU }))  → the same bubble must change.
// Pass = the card arrives on SMOKE_TO's iPhone, opens /setup inside Messages, and step 4 changes that same bubble.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signToken, TOKEN_TTL_SEC } from "@rove/shared";
import type { MerchantSessionPayload, Recipient } from "@rove/shared";
import { DEMO_MENU, DEMO_MERCHANT } from "@rove/shared/mocks";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createCardBuilders } from "../src/builders";
import { createSpectrumCardPresenter } from "../src/presenter";

const WAIT_MS = 5_000;

// ------------------------------------------------------------------ env

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath); // real env vars win over .env

const REQUIRED = {
  SPECTRUM_PROJECT_ID: "Photon Spectrum project id (from Saran)",
  SPECTRUM_PROJECT_SECRET: "Photon Spectrum project secret (from Saran)",
  PUBLIC_BASE_URL: "public https URL of the web app, e.g. https://rove-demo.vercel.app",
  TOKEN_SECRET: "HMAC key for merchant page sessions (must match the web app's)",
  SMOKE_TO: "E.164 phone of the test iPhone that should receive the card, e.g. +6591234567",
} as const;

const missing = (Object.keys(REQUIRED) as Array<keyof typeof REQUIRED>).filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error("card-smoke: missing env vars:\n");
  for (const k of missing) console.error(`  ${k.padEnd(24)} ${REQUIRED[k]}`);
  console.error(`\nSet them in ${envPath} (see .env.example) or inline:`);
  console.error("  SMOKE_TO=+6591234567 pnpm --filter @rove/imessage-apps card-smoke");
  process.exit(1);
}
const env = Object.fromEntries(Object.keys(REQUIRED).map((k) => [k, process.env[k]!.trim()])) as Record<keyof typeof REQUIRED, string>;
if (!/^\+\d{8,15}$/.test(env.SMOKE_TO)) {
  console.error(`card-smoke: SMOKE_TO must be E.164 like +6591234567, got ${JSON.stringify(env.SMOKE_TO)}`);
  process.exit(1);
}
if (!/^https:\/\//.test(env.PUBLIC_BASE_URL)) {
  console.warn(`card-smoke: PUBLIC_BASE_URL is not https (${env.PUBLIC_BASE_URL}); iMessage may not render the card preview.`);
}

// ------------------------------------------------------------------ run

const merchant = { ...DEMO_MERCHANT, phone: env.SMOKE_TO, channel: "imessage" as const };
const to: Recipient = { phone: merchant.phone, channel: "imessage" };
const sessionToken = signToken<MerchantSessionPayload>(
  { merchantId: merchant.id, scope: "setup", exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC.setup },
  env.TOKEN_SECRET,
);
const builders = createCardBuilders({ baseUrl: env.PUBLIC_BASE_URL });

console.log(`card-smoke: booting Spectrum (iMessage) for project ${env.SPECTRUM_PROJECT_ID}…`);
const spectrum = await Spectrum({
  projectId: env.SPECTRUM_PROJECT_ID,
  projectSecret: env.SPECTRUM_PROJECT_SECRET,
  providers: [imessage.config()],
});

let ok = false;
try {
  const presenter = createSpectrumCardPresenter(spectrum);

  const first = builders.setup({ merchant, menu: [], sessionToken });
  console.log(`[1/2] send   ${first.kind} ${first.key} live=${first.live}\n      ${first.url}`);
  const sent = await presenter.send(to, first);
  console.log(`      → messageId=${sent.messageId} edited=${sent.edited}`);

  console.log(`      waiting ${WAIT_MS / 1000}s… (tap the card on the phone to check it opens /setup inside Messages)`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const second = builders.setup({ merchant, menu: DEMO_MENU, sessionToken });
  if (second.url === first.url) console.warn("      ! the builder produced the same URL for a different menu (v didn't change)");
  console.log(`[2/2] update ${second.kind} ${second.key}\n      ${second.url}`);
  const updated = await presenter.update(to, second);
  console.log(`      → messageId=${updated?.messageId ?? "(none)"} edited=${updated?.edited ?? false}`);

  ok = updated !== null && updated.edited && updated.messageId === sent.messageId;
  console.log(
    ok
      ? "\ncard-smoke: PASS (API side): the update edited the original bubble. Confirm on the phone that the SAME bubble changed."
      : "\ncard-smoke: FAIL: the update did not edit the original bubble.",
  );
} catch (err) {
  console.error("card-smoke: error:", err);
} finally {
  await spectrum.stop();
}
process.exit(ok ? 0 : 1);
