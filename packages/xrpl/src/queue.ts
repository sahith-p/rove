// One-in-flight submit queue per signing account. Two transactions from the same account in flight at once
// would race for the same Sequence (tefPAST_SEQ). Everything a signer does (autofill → sign → submit → wait)
// runs inside its slot, so the next job always autofills against the validated result of the previous one.

export class SubmitQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `job` after every earlier job for `key` has settled (fulfilled or rejected). */
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Whether `key` has a job queued or running. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** Process-wide queue: every engine instance in a process shares it, so a signer never has two txs in flight. */
export const submitQueue = new SubmitQueue();
