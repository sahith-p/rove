// One-at-a-time work per withdrawal inside this process. Owner: Nithya · Task: NI-C4.
// Every pipeline step, partner callback, re-execute and boot resume for a withdrawal runs through serial(id, …), so a
// callback that lands while the pipeline is still recording the payout waits for it instead of racing it, and a
// re-execute that arrives mid-flight queues behind the running step and then finds the withdrawal already advanced.
// Across processes the compare-and-set on `status` in the DB is still what keeps steps from repeating.

const tails = new Map<string, Promise<void>>();

/** Runs `fn` after everything queued for `key` before it (whether that succeeded or not). */
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** Resolves once everything queued for `key` so far has finished. */
export function idle(key: string): Promise<void> {
  return tails.get(key) ?? Promise.resolve();
}
