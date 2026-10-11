// Unpaid invoice nudges + 21:00 voice recap. [stub]
import type { Deps, Voice } from "./ports";
export function startReminders(_deps: Deps, _m: { voice: Voice }): { stop(): void; runOnce(): Promise<void> } {
  throw new Error("not implemented: startReminders");
}
