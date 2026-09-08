import { AbstractStreamingSyncImplementation, LockType, Mutex } from "@powersync/shared-internals";
import type { AbstractStreamingSyncImplementationOptions, LockOptions } from "@powersync/shared-internals";
export declare class LynxStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
    locks: Map<LockType, Mutex>;
    constructor(options: AbstractStreamingSyncImplementationOptions);
    initLocks(): void;
    obtainLock<T>(lockOptions: LockOptions<T>): Promise<T>;
}
