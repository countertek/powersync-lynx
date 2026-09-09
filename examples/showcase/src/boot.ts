import { errorMessage } from "./util.ts";

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

export interface DemoBootCredentials {
  endpoint: string;
  token: string;
}

export interface DemoBootHooks {
  waitForReady: () => Promise<void>;
  fetchCredentials: () => Promise<DemoBootCredentials | null>;
  setCredentials: (creds: DemoBootCredentials) => void;
  connect: () => Promise<void>;
  onLocalReady: () => void;
  onConnectSettled?: () => void;
  log: (message: string) => void;
  isCancelled: () => boolean;
  connectLabel: string;
}

/**
 * Open the local DB and mark the live-query UI ready before connect() settles.
 * connect() waits for the /sync/stream handshake; a live stream must not block
 * local CRUD. Handshake failures are logged, not thrown.
 */
export async function bootDemo(hooks: DemoBootHooks): Promise<void> {
  await hooks.waitForReady();
  if (hooks.isCancelled()) {
    return;
  }
  hooks.log("waitForReady: database open");
  hooks.onLocalReady();
  try {
    const creds = await hooks.fetchCredentials();
    if (hooks.isCancelled()) {
      return;
    }
    if (creds == null) {
      hooks.log("token: demo API returned no credentials; staying offline");
      return;
    }
    hooks.setCredentials(creds);
    await hooks.connect();
    if (hooks.isCancelled()) {
      return;
    }
    hooks.log(`connect: ${hooks.connectLabel}`);
    hooks.onConnectSettled?.();
  } catch (err) {
    hooks.log(
      `connect skipped: ${errorMessage(err)}. Start the sync profile (examples/README.md). Writes still queue locally.`,
    );
  }
}
