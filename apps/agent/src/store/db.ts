// Store over @rove/db (Nithya, NI-B1). Owner: Saran (adapter only; the queries live in packages/db).
//
// @rove/db exports nothing yet. Once NI-B1 merges, this becomes a thin adapter: `import * as db from "@rove/db"`
// and map each Store method to the helper of the same name. Helpers the agent needs that are NOT in the planned
// @rove/db surface (requested in tasks/integration.md):
//   listLiveMerchants() · getInvoice(id) · invoicesDueForReminder(createdBefore) · markInvoiceReminded(id)
//   setActionMessageIds(id, ids) · findActionByMessageId(msgId) (any status) · finishAction(id, status, result)
//   expireActions() · findActionByRef(withdrawalId | paymentId)
// Until then, run the agent offline (leave SUPABASE_URL empty) on the in-memory store + mock worker.

import type { Store } from "../ports";

export function createDbStore(): Store {
  throw new Error(
    "SUPABASE_URL is set, but the @rove/db helpers (NI-B1) aren't merged yet, so the agent has no database store. " +
      "Unset SUPABASE_URL to run offline on the in-memory store + mock worker.",
  );
}
