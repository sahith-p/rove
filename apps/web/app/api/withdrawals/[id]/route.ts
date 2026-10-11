// GET /api/withdrawals/:id (withdrawal scope with ref = id, or the owner's shop scope) → WithdrawalRes
// Owner: Nithya · Task: NI-B6 · Spec: docs/specs/withdrawals.md §3d · Schemas: @rove/shared api.ts
//
// The /w page polls this every second until a terminal status: one withdrawal read + one bank account read (bank
// destinations), nothing else. Another merchant's withdrawal is a 404, same as an unknown id, so ids can't be probed.

import { getWebDeps } from "../../_lib/deps";
import { HttpError, json, route } from "../../_lib/http";
import { requireSession } from "../../_lib/session";
import { toWithdrawalView } from "../../_lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  // withdrawal scope: the token's ref must be this id (403 wrong_ref otherwise). shop scope: ownership checked below.
  const session = requireSession(req, ["withdrawal", "shop"], { ref: id });

  const deps = getWebDeps();
  const withdrawal = await deps.db.getWithdrawal(id);
  if (!withdrawal || withdrawal.merchantId !== session.merchantId) {
    throw new HttpError(404, "withdrawal_not_found", "We couldn't find this withdrawal. Text Rove 'withdrawal status' for a new link.");
  }

  return json(await toWithdrawalView(deps, withdrawal)); // no-store
});
