// In-memory Store seeded with the demo fixtures (offline dev + evals). Owner: Saran. [stub: filled by the store/worker lane]
import type { Store } from "../ports";
export function createMemoryStore(_opts: { now: () => Date }): Store {
  throw new Error("not implemented: createMemoryStore");
}
