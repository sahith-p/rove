// GET|POST /api/x402/invoices/:code: pay a Rove invoice over x402 v2 (HTTP 402) in AUSD on Base Sepolia, gasless for the
// paying agent. Owner: Nithya · Spec: docs/specs/ausd-lane.md §x402 · Logic: ../../invoice.ts, protocol: ../../protocol.ts.
//   no PAYMENT-SIGNATURE → 402 PaymentRequired · with it → 200 receipt + PAYMENT-RESPONSE (202 while still relaying)
//   400 invalid_payment · 404 invoice_not_found · 409 invoice_paid / authorization_reused · 410 invoice_paid / _expired /
//   _cancelled · 503 ausd_not_configured / chain_unavailable

import { getAusdDeps } from "../../../_lib/ausd";
import { getWebDeps } from "../../../_lib/deps";
import { route } from "../../../_lib/http";
import { handleX402Invoice } from "../../invoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The handler waits up to 30s for the relayer to land the transfer. */
export const maxDuration = 60;

type Ctx = { params: Promise<{ code: string }> };

const handler = route<Ctx>(async (req, { params }) => {
  const { code } = await params;
  return handleX402Invoice(req, code, getWebDeps(), getAusdDeps());
});

export const GET = handler;
export const POST = handler;
