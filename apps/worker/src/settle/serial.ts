// In-process serialization by key (one worker process in the demo; the DB compare-and-sets are the real guard).
// Scoped to an owner object (the Db) so tests with separate databases never wait on each other.

export interface Serial {
  /** Runs `fn` after every earlier call with the same key has finished (fulfilled or rejected). */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** True while a call for `key` is queued or running. */
  busy(key: string): boolean;
}

export function createSerial(): Serial {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(fn, fn);
      const tail = result.then(
        () => {},
        () => {},
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    busy: (key) => tails.has(key),
  };
}

/** One Serial per owner (e.g. per Db instance). */
export function serialFor(registry: WeakMap<object, Serial>, owner: object): Serial {
  let s = registry.get(owner);
  if (!s) {
    s = createSerial();
    registry.set(owner, s);
  }
  return s;
}
