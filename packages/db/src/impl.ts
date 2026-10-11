// The Db implementation: one set of SQL over any executor (postgres.js in deploys, PGlite in tests).

import type { Pool } from "./executor";
import type { Db } from "./index";
import { agentRepo } from "./repo/agent";
import { ausdRepo } from "./repo/ausd";
import { contactsRepo } from "./repo/contacts";
import { invoicesRepo, type InvoicesRepoOptions } from "./repo/invoices";
import { ledgerRepo } from "./repo/ledger";
import { menuRepo } from "./repo/menu";
import { merchantsRepo } from "./repo/merchants";
import { paymentsRepo } from "./repo/payments";
import { refundsRepo } from "./repo/refunds";
import { withdrawalsRepo } from "./repo/withdrawals";

export interface MakeDbOptions extends InvoicesRepoOptions {}

export function makeDb(pool: Pool, opts: MakeDbOptions = {}): Db {
  const invoices = invoicesRepo(pool, opts);
  const agent = agentRepo(pool);
  return {
    ...merchantsRepo(pool),
    ...menuRepo(pool),
    ...contactsRepo(pool),
    ...invoices,
    ...paymentsRepo(pool),
    ...ledgerRepo(pool),
    ...withdrawalsRepo(pool),
    ...refundsRepo(pool),
    ...agent,
    ...ausdRepo(pool),
    // Names the agent's Store uses (Saran/Sahith 15:40); same behavior as the originals.
    invoicesDueForReminder: (createdBefore) => invoices.invoicesToRemind(new Date(createdBefore)),
    finishAction: (id, status, result) => agent.setActionStatus(id, status, result),
    close: () => pool.end(),
  };
}
