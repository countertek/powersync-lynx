import "../abort-controller.js";
import { DBAdapter } from "@powersync/common";
import type { DBLockOptions, LockContext, QueryResult } from "@powersync/common";
import { Semaphore } from "@powersync/shared-internals";
import { LynxConnection } from "./LynxConnection.js";
import { type BindValueRows } from "./native.js";
export interface LynxAdapterOpenOptions {
    name: string;
    dbLocation?: string;
}
interface NestedAbortSignal {
    signal: AbortSignal;
    cleanUpInnerSignal?: () => void;
}
export declare class LynxDBAdapter extends DBAdapter {
    name: string;
    initialized: Promise<void>;
    readConnections: Semaphore<LynxConnection> | null;
    writeConnection: Semaphore<LynxConnection> | null;
    abortController: AbortController;
    options: LynxAdapterOpenOptions;
    constructor(options: LynxAdapterOpenOptions);
    init(): Promise<void>;
    openConnection(readOnly: boolean, dbFilename: string): Promise<LynxConnection>;
    writers(): Semaphore<LynxConnection>;
    readers(): Semaphore<LynxConnection>;
    close(): Promise<void>;
    generateNestedAbortSignal(options?: DBLockOptions): NestedAbortSignal;
    readLock<T>(fn: (tx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T>;
    writeLock<T>(fn: (tx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T>;
    refreshSchema(): Promise<void>;
    executeBatch(query: string, params?: BindValueRows): Promise<QueryResult<never>>;
}
export {};
