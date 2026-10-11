// Merchant tools (MerchantToolInputs in @rove/shared/agent.ts). Spec: docs/specs/agent.md §4, docs/specs/invoicing-and-qr.md.
// Every tool closes over ctx.merchant (the sender's own shop); none takes a merchant id from the model.

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { ToolContext } from "../context";
import { billingTools } from "./billing";
import { moneyTools } from "./money";
import { shopTools } from "./shop";

export function merchantTools(ctx: ToolContext): BetaRunnableTool[] {
  return [...shopTools(ctx), ...billingTools(ctx), ...moneyTools(ctx)] as BetaRunnableTool[];
}
