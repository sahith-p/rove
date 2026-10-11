// TypeScript types for the internal route bodies, inferred from the zod schemas in @rove/shared api.ts.
// The worker has no direct zod dependency, so `Infer<S>` reads the schema's `_output` (same result as `z.infer`).
// The schemas themselves (values) are imported from @rove/shared where they're used (server.ts validates).

import type * as api from "@rove/shared";

export type Infer<S extends { _output: unknown }> = S["_output"];

export type InternalSettleReq = Infer<typeof api.InternalSettleReq>;
export type InternalRefundReq = Infer<typeof api.InternalRefundReq>;
export type InternalRefundRes = Infer<typeof api.InternalRefundRes>;
export type InternalCreateWithdrawalReq = Infer<typeof api.InternalCreateWithdrawalReq>;
export type InternalExecuteWithdrawalReq = Infer<typeof api.InternalExecuteWithdrawalReq>;
export type InternalCreateMerchantReq = Infer<typeof api.InternalCreateMerchantReq>;
export type InternalCreateMerchantRes = Infer<typeof api.InternalCreateMerchantRes>;
export type InternalSetAutoWithdrawReq = Infer<typeof api.InternalSetAutoWithdrawReq>;
/** `InternalCreateWithdrawalRes` and the web's `WithdrawalRes` are both this shape. */
export type WithdrawalView = Infer<typeof api.WithdrawalViewZ>;
