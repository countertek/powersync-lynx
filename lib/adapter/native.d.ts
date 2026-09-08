import type { SqliteValue } from "@powersync/common";
export type BindValue = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array | readonly number[];
export type BindValues = readonly BindValue[];
export type BindValueRows = readonly BindValues[];
export type NativeCell = SqliteValue | ArrayBuffer;
export interface NativeOkEnvelope {
    ok: true;
    dbId?: string;
    insertId?: number;
    rowsAffected?: number;
    columnNames?: string[];
    rawRows?: NativeCell[][];
}
export interface NativeFailEnvelope {
    ok: false;
    message: string;
    code?: number;
}
export type NativeEnvelope = NativeOkEnvelope | NativeFailEnvelope;
export interface NativeWireEnvelope {
    ok?: boolean;
    message?: string;
    code?: number;
    dbId?: string;
    insertId?: number;
    rowsAffected?: number;
    columnNames?: string[];
    rawRows?: NativeCell[][];
}
export interface OpenPayload {
    dbFilename: string;
    readOnly: boolean;
    dbLocation?: string;
}
export type NativeCallback = (envelope: NativeWireEnvelope) => void;
export interface NativePowerSyncModule {
    open(options: OpenPayload, callback: NativeCallback): void;
    close(dbId: string, callback: NativeCallback): void;
    execute(dbId: string, sql: string, params: BindValues, callback: NativeCallback): void;
    executeBatch(dbId: string, sql: string, params: BindValueRows, callback: NativeCallback): void;
}
export interface NativeModulesHost {
    NativePowerSyncModule?: NativePowerSyncModule;
}
export declare class NativeModuleError extends Error {
    code?: number;
}
export declare function callNative(method: "open", payload: OpenPayload): Promise<NativeOkEnvelope>;
export declare function callNative(method: "close", dbId: string): Promise<NativeOkEnvelope>;
export declare function callNative(method: "execute", dbId: string, sql: string, params: BindValues): Promise<NativeOkEnvelope>;
export declare function callNative(method: "executeBatch", dbId: string, sql: string, params: BindValueRows): Promise<NativeOkEnvelope>;
export declare function blobToArrayBuffer(value: BindValue): BindValue;
export declare function encodeBindParams(params: BindValues | null | undefined): BindValue[];
export declare function encodeBindParamRows(params: BindValueRows | null | undefined): BindValue[][];
export declare function decodeCell(value: NativeCell): SqliteValue;
export declare function decodeRawRows(rawRows: NativeCell[][] | null | undefined): SqliteValue[][];
