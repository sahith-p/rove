// Sends one Rove invoice card for an existing invoice code to SMOKE_TO (visual check of the in-card layout).
//   SMOKE_CODE=52ZMND SMOKE_TOTAL=12.50 pnpm --filter @rove/imessage-apps exec tsx scripts/invoice-smoke.ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Invoice, Recipient } from "@rove/shared";
import { DEMO_MERCHANT } from "@rove/shared/mocks";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createCardBuilders } from "../src/builders";
import { createSpectrumCardPresenter } from "../src/presenter";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const e = (k: string) => process.env[k]?.trim() || (console.error(`missing ${k}`), process.exit(1));

const to: Recipient = { phone: e("SMOKE_TO"), channel: "imessage" };
const code = process.env.SMOKE_CODE ?? "52ZMND";
const invoice: Invoice = {
  id: `inv_${code}`, code, merchantId: DEMO_MERCHANT.id, kind: "invoice", contactId: null, to,
  lines: [], total: { amount: process.env.SMOKE_TOTAL ?? "12.50", currency: "SGD" }, note: null, status: "open",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), paymentId: null, createdAt: new Date().toISOString(),
};
const spec = createCardBuilders({ baseUrl: e("PUBLIC_BASE_URL") }).invoice({ invoice, merchant: DEMO_MERCHANT });
const spectrum = await Spectrum({ projectId: e("SPECTRUM_PROJECT_ID"), projectSecret: e("SPECTRUM_PROJECT_SECRET"), providers: [imessage.config()] });
try {
  console.log(spec.url, JSON.stringify(spec.layout));
  const sent = await createSpectrumCardPresenter(spectrum).send(to, spec);
  console.log("sent", sent.messageId);
} finally {
  await (spectrum as any).stop?.();
  process.exit(0);
}
