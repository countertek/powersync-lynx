import { type Cloneable, type CloneableObject } from "./cloneable.js";
export declare const MODULE_NAME = "NativePowerSyncModule";
declare const ATTACH_OPTION_KEYS: readonly ["vfs", "useWebWorker", "enableMultiTabs", "worker", "additionalReaders", "temporaryStorage", "cacheSizeKb", "databaseWorkerLogLevel", "disableSSRWarning"];
export type AttachOptionKey = (typeof ATTACH_OPTION_KEYS)[number];
export interface WASQLiteWorkerFactoryOptions {
    readonly name?: string;
}
export type WASQLiteWorkerFactory = (options: WASQLiteWorkerFactoryOptions) => Worker | SharedWorker;
export interface AttachOptions {
    vfs?: string;
    useWebWorker?: boolean;
    enableMultiTabs?: boolean;
    worker?: string | URL | WASQLiteWorkerFactory;
    additionalReaders?: number;
    temporaryStorage?: string;
    cacheSizeKb?: number;
    databaseWorkerLogLevel?: number;
    disableSSRWarning?: boolean;
}
export interface WASQLiteOpenFields extends AttachOptions {
    dbFilename: string;
    dbLocation?: string;
}
export type WASQLiteBindValue = Cloneable | Uint8Array | WASQLiteBindValue[];
export interface WASQLiteTx {
    executeRaw(sql: string, params: WASQLiteBindValue): Promise<WASQLiteQueryResult>;
    executeBatch(sql: string, params: WASQLiteBindValue): Promise<WASQLiteQueryResult>;
}
export interface WASQLiteAdapter {
    readLock<T>(fn: (tx: WASQLiteTx) => Promise<T>): Promise<T>;
    writeLock<T>(fn: (tx: WASQLiteTx) => Promise<T>): Promise<T>;
    close(): Promise<void> | void;
}
export interface WASQLiteFactoryHandle {
    openDB(): WASQLiteAdapter | Promise<WASQLiteAdapter>;
}
export interface PowerSyncLoggerLike {
    log(record: {
        level: number;
        message: string;
    }): void;
}
export interface PowerSyncWebModule {
    WASQLiteOpenFactory: new (options: {
        open: WASQLiteOpenFields;
        logger: PowerSyncLoggerLike;
    }) => WASQLiteFactoryHandle;
    createConsoleLogger?: (options: {
        prefix: string;
    }) => PowerSyncLoggerLike;
}
export type LoadWeb = () => Promise<PowerSyncWebModule>;
export interface WASQLiteQueryResult {
    insertId?: number;
    rowsAffected?: number;
    columnNames?: string[];
    rawRows?: Cloneable[][];
    array?: CloneableObject[];
    rows?: {
        _array?: CloneableObject[];
    } | CloneableObject[];
}
export declare function fileKey(dbFilename: string, dbLocation?: string): string;
export declare function resetWebHostMapping(): void;
export interface MappingStats {
    files: number;
    connections: number;
}
export declare function mappingStats(): MappingStats;
export declare function handleNativeCall(name: string, encodedData: Cloneable, attachOptions: AttachOptions | undefined, loadWeb: LoadWeb): Promise<Cloneable>;
export type NativeModulesCallHandler = (name: string, data: Cloneable, moduleName: string) => Cloneable | Promise<Cloneable | undefined> | undefined;
export declare function createOnNativeModulesCall(previous: NativeModulesCallHandler | null | undefined, attachOptions: AttachOptions | undefined, loadWeb: LoadWeb): NativeModulesCallHandler;
export {};
