import { AbstractStreamingSyncImplementation, LockType, Mutex } from "@powersync/shared-internals";
import type {
  AbstractStreamingSyncImplementationOptions,
  LockOptions,
} from "@powersync/shared-internals";

const LOCKS = new Map<string, Map<LockType, Mutex>>();

export class LynxStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
  locks: Map<LockType, Mutex>;

  constructor(options: AbstractStreamingSyncImplementationOptions) {
    super(options);
    this.locks = new Map();
    this.initLocks();
  }

  initLocks(): void {
    const { identifier } = this.options;
    if (identifier && LOCKS.has(identifier)) {
      const existing = LOCKS.get(identifier);
      if (existing) {
        this.locks = existing;
        return;
      }
    }

    this.locks = new Map();
    this.locks.set(LockType.CRUD, new Mutex());
    this.locks.set(LockType.SYNC, new Mutex());

    if (identifier) {
      LOCKS.set(identifier, this.locks);
    }
  }

  obtainLock<T>(lockOptions: LockOptions<T>): Promise<T> {
    const lock = this.locks.get(lockOptions.type);
    if (!lock) {
      throw new Error(`Lock type ${lockOptions.type} not found`);
    }
    return lock.runExclusive(async () => {
      return lockOptions.callback();
    }, lockOptions.signal);
  }
}
