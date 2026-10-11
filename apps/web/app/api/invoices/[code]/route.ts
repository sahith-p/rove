// GET /api/invoices/:code → InvoicePublicRes
// Owner: Nithya · Task: NI-B4 · Spec: docs/specs/payments-stripe.md §4, docs/specs/invoicing-and-qr.md · Schemas: @rove/shared api.ts
// Public (no auth): codes are unguessable. Case-insensitive code. Status reflects expiry even before the worker's sweep.

import { InvoicePublicRes } from "@rove/shared";
import { getWebDeps } from "../../_lib/deps";
import { HttpError, route } from "../../_lib/http";
import { merchantVerified, publicInvoiceStatus, respond } from "../../shops/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

const NOT_FOUND = () => new HttpError(404, "invoice_not_found", "This payment link doesn't exist. Ask the shop for a new one.");

export const GET = route<Ctx>(async (_req, { params }) => {
  const { code: raw } = await params;
  const code = raw.trim();
  if (!code || code.length > 32) throw NOT_FOUND();

  const deps = getWebDeps();
  const invoice = await deps.db.getInvoiceByCode(code);
  if (!invoice) throw NOT_FOUND();
  const merchant = await deps.db.getMerchant(invoice.merchantId);
  if (!merchant) throw NOT_FOUND();

  return respond(InvoicePublicRes, {
    code: invoice.code,
    kind: invoice.kind,
    merchant: { id: merchant.id, name: merchant.name, verified: await merchantVerified(deps, merchant) },
    lines: invoice.lines,
    total: invoice.total,
    note: invoice.note,
    status: publicInvoiceStatus(invoice),
    expiresAt: invoice.expiresAt,
  });
});
