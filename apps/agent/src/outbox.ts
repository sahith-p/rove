// Outbox implementations: Spectrum (iMessage + WhatsApp) and console/recording (mock cards, evals). [stub]
import type { Outbox } from "./ports";
export interface RecordedSend { kind: string; to: string; body: string; messageId: string }
export function createConsoleOutbox(_opts: { log: (line: string) => void; record?: RecordedSend[] }): Outbox {
  throw new Error("not implemented: createConsoleOutbox");
}
