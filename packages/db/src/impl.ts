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
  return {
    ...merchantsRepo(pool),
    ...menuRepo(pool),
    ...contactsRepo(pool),
    ...invoicesRepo(pool, opts),
    ...paymentsRepo(pool),
    ...ledgerRepo(pool),
    ...withdrawalsRepo(pool),
    ...refundsRepo(pool),
    ...agentRepo(pool),
    ...ausdRepo(pool),
    close: () => pool.end(),
  };
}
