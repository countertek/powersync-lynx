/**
 * Coalesce concurrent first-load callers (ReactLynx Strict-mode double mount,
 * overlapping refresh) onto one in-flight run.
 */
export function runExclusive(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending == null) {
      pending = run().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

/**
 * Ignore a stale watch snapshot if a newer one has already been delivered.
 * First-load-then-refresh used to lose or duplicate rows when an empty
 * snapshot arrived after the real one.
 */
export function createSnapshotGate(): {
  take(): number;
  isCurrent(token: number): boolean;
} {
  let generation = 0;
  return {
    take() {
      generation += 1;
      return generation;
    },
    isCurrent(token: number) {
      return token === generation;
    },
  };
}
