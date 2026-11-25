import { AbstractStreamingSyncImplementation, LockType, Mutex } from "@powersync/shared-internals";
import type {
  AbstractStreamingSyncImplementationOptions,
  LockOptions,
} from "@powersync/shared-internals";
import type { TabCoordinator, TabSyncClient } from "../tabs.ts";

const LOCKS = new Map<string, Map<LockType, Mutex>>();

export class LynxStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
  locks: Map<LockType, Mutex>;
  private readonly tabs: TabCoordinator | undefined;
  private readonly tabSyncClient: TabSyncClient;

  constructor(options: AbstractStreamingSyncImplementationOptions, tabs?: TabCoordinator) {
    super(options);
    this.tabs = tabs;
    this.tabSyncClient = {
      getSyncStatus: () => this.syncStatus,
      updateSyncStatus: (core, jsState) => {
        if (jsState == null) {
          this.updateSyncStatus(core);
        } else {
          this.updateSyncStatus(core, jsState);
        }
      },
      onStatusChanged: (listener) =>
        this.registerListener({
          statusChanged: listener,
        }),
    };
    this.locks = new Map();
    this.initLocks();
  }

  initLocks(): void {
    const lockKey = this.tabs?.fileKey ?? this.options.identifier;
    if (lockKey && LOCKS.has(lockKey)) {
      const existing = LOCKS.get(lockKey);
      if (existing) {
        this.locks = existing;
        return;
      }
    }

    this.locks = new Map();
    this.locks.set(LockType.CRUD, new Mutex());
    this.locks.set(LockType.SYNC, new Mutex());

    if (lockKey) {
      LOCKS.set(lockKey, this.locks);
    }
  }

  async obtainLock<T>(lockOptions: LockOptions<T>): Promise<T> {
    const runLocal = () => {
      const lock = this.locks.get(lockOptions.type);
      if (!lock) {
        throw new Error(`Lock type ${lockOptions.type} not found`);
      }
      return lock.runExclusive(async () => {
        return lockOptions.callback();
      }, lockOptions.signal);
    };
    if (this.tabs != null) {
      return this.tabs.obtainLock(this.tabSyncClient, lockOptions, runLocal);
    }
    return runLocal();
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
    this.tabs?.leaveSyncLease(this.tabSyncClient);
  }

  async dispose(): Promise<void> {
    await super.dispose();
    this.tabs?.disposeSync(this.tabSyncClient);
  }
}
