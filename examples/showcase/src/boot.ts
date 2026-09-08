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
