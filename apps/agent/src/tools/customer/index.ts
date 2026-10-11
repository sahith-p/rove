// Customer tools (CustomerToolInputs). [stub]
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { Recipient } from "@rove/shared";
import type { ToolContext } from "../context";
export function customerTools(_ctx: ToolContext): BetaRunnableTool[] {
  throw new Error("not implemented: customerTools");
}
/** Payment-code fast path (no Claude): send the pay card for a typed code, or a one-line answer. */
export async function payCodeFastPath(_ctx: Omit<ToolContext, "calls">, _from: Recipient, _code: string): Promise<string> {
  throw new Error("not implemented: payCodeFastPath");
}
