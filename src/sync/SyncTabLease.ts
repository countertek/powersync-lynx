import type { TabLocks } from "../tabs.ts";

interface Claim {
  held: boolean;
  granted: Promise<void>;
  /** Withdraws a claim that is still queued, or gives up a granted one. */
  end(): void;
}

/**
 * This sync client's claim on being the one that syncs a database shared between tabs.
 *
 * Kept from the first grant until {@link drop}, across sync iterations, so the role
 * only moves when the holder disconnects or its tab closes.
 */
export class SyncTabLease {
  private readonly locks: TabLocks;
  private readonly name: string;
  private claim: Claim | null = null;

  constructor(locks: TabLocks, name: string) {
    this.locks = locks;
    this.name = name;
  }

  get held(): boolean {
    return this.claim?.held === true;
  }

  /** Resolves `true` once this client holds the lease, `false` when `signal` aborts first. */
  hold(signal?: AbortSignal): Promise<boolean> {
    const claim = this.claim ?? this.request();
    this.claim = claim;
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(false);
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
      claim.granted.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, reject);
    });
  }

  drop(): void {
    const claim = this.claim;
    this.claim = null;
    claim?.end();
  }

  private request(): Claim {
    const withdrawn = new AbortController();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim: Claim = {
      held: false,
      granted: Promise.resolve(),
      end() {
        claim.held = false;
        withdrawn.abort();
        release();
      },
    };
    claim.granted = new Promise((resolve, reject) => {
      this.locks
        .request(
          this.name,
          () => {
            if (!withdrawn.signal.aborted) {
              claim.held = true;
              resolve();
            }
            return released;
          },
          withdrawn.signal,
        )
        .catch((error: Error) => {
          if (withdrawn.signal.aborted) {
            // Withdrawn while queued: whoever waited has already been told by its own signal.
            return;
          }
          if (this.claim === claim) {
            this.claim = null;
          }
          reject(error);
        });
    });
    return claim;
  }
}
