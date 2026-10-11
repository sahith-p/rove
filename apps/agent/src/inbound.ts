// Routes one inbound message: persona → reaction / poll vote / contact / voice / YES / payment code / Claude. [stub]
import type { Recipient } from "@rove/shared";
import type { Inbound, ReplyChannel } from "./ports";
import type { Agent } from "./app";
export async function handleInbound(_agent: Agent, _from: Recipient, _msg: Inbound, _reply: ReplyChannel): Promise<void> {
  throw new Error("not implemented: handleInbound");
}
