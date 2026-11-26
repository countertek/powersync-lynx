import { queryResultWithoutRows } from "@powersync/common";
import type { QueryResult, RawQueryResult, SqliteValue } from "@powersync/common";
import { getLynxHost } from "../host.ts";
import type { LynxFetchModule, NativeSyncHttpModule } from "../sync/transport/http-types.ts";
import { isBigInt } from "../type-guards.ts";
import {
  copyToArrayBuffer,
  decodeTaggedBigInt,
  encodeTaggedBigInt,
  isNumberArray,
  type TaggedBigInt,
} from "../values.ts";

export type { TaggedBigInt };

export type BindValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | ArrayBuffer
  | Uint8Array
  | readonly number[]
  | TaggedBigInt;

export type BindValues = readonly BindValue[];
export type BindValueRows = readonly BindValues[];

export type NativeCell = SqliteValue | ArrayBuffer | TaggedBigInt;

export interface NativeOkEnvelope {
  ok: true;
  dbId?: string;
  /** `open` on the web Host helper only: other tabs share this database file. */
  multiTab?: boolean;
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
  multiTab?: boolean;
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

export interface OpenedNativeConnection {
  dbId: string;
  multiTab: boolean;
}

export type NativeCallback = (envelope: NativeWireEnvelope) => void;

export interface NativePowerSyncModule {
  open(options: OpenPayload, callback: NativeCallback): void;
  close(dbId: string, callback: NativeCallback): void;
  execute(dbId: string, sql: string, params: BindValues, callback: NativeCallback): void;
  executeBatch(dbId: string, sql: string, params: BindValueRows, callback: NativeCallback): void;
}

export interface NativeModulesHost {
  /** SQL RPC; iOS/Android/Desktop hosts may also carry NativeSyncHttp methods. */
  NativePowerSyncModule?: NativePowerSyncModule & Partial<NativeSyncHttpModule>;
  LynxFetchModule?: LynxFetchModule;
}

export class NativeModuleError extends Error {
  code?: number;
}

function getNativeModule(): NativePowerSyncModule {
  const native = getLynxHost().nativeModules()?.NativePowerSyncModule;
  if (native == null) {
    throw new Error("NativePowerSyncModule is not registered");
  }
  return native;
}

function parseNativeEnvelope(envelope: NativeWireEnvelope | null | undefined): NativeEnvelope {
  if (envelope == null || envelope.ok === false) {
    const failed: NativeFailEnvelope = {
      ok: false,
      message: envelope?.message ?? "NativePowerSyncModule request failed",
    };
    if (envelope?.code != null) {
      failed.code = envelope.code;
    }
    return failed;
  }
  const ok: NativeOkEnvelope = { ok: true };
  if (envelope.dbId !== undefined) ok.dbId = envelope.dbId;
  if (envelope.multiTab === true) ok.multiTab = true;
  if (envelope.insertId !== undefined) ok.insertId = envelope.insertId;
  if (envelope.rowsAffected !== undefined) ok.rowsAffected = envelope.rowsAffected;
  if (envelope.columnNames !== undefined) ok.columnNames = envelope.columnNames;
  if (envelope.rawRows !== undefined) ok.rawRows = envelope.rawRows;
  return ok;
}

function rejectNative(envelope: NativeFailEnvelope): NativeModuleError {
  const error = new NativeModuleError(envelope.message);
  if (envelope.code != null) {
    error.code = envelope.code;
  }
  return error;
}

function withNativeCallback(run: (callback: NativeCallback) => void): Promise<NativeOkEnvelope> {
  return new Promise((resolve, reject) => {
    run((envelope) => {
      const parsed = parseNativeEnvelope(envelope);
      if (parsed.ok === false) {
        reject(rejectNative(parsed));
        return;
      }
      resolve(parsed);
    });
  });
}

function blobToArrayBuffer(value: BindValue): BindValue {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return copyToArrayBuffer(value);
  }
  if (isNumberArray(value)) {
    return copyToArrayBuffer(Uint8Array.from(value));
  }
  return value;
}

function encodeBindParams(params: BindValues | null | undefined): BindValue[] {
  if (params == null) {
    return [];
  }
  return params.map((value) => {
    if (isBigInt(value)) {
      return encodeTaggedBigInt(value);
    }
    return blobToArrayBuffer(value);
  });
}

function encodeBindParamRows(params: BindValueRows | null | undefined): BindValue[][] {
  if (params == null) {
    return [];
  }
  return params.map(encodeBindParams);
}

function decodeCell(value: NativeCell): SqliteValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  const tagged = decodeTaggedBigInt(value);
  if (tagged !== undefined) {
    return tagged;
  }
  // SAFETY: remaining NativeCell after ArrayBuffer and __psBig handling is a SqliteValue.
  return value as SqliteValue;
}

function decodeRawRows(rawRows: NativeCell[][] | null | undefined): SqliteValue[][] {
  return (rawRows ?? []).map((row) => (row ?? []).map(decodeCell));
}

/**
 * Deep SQL RPC seam over callback-based {@link NativePowerSyncModule} (ADR-0001).
 * Owns envelope parsing, non-null `dbId` checks, bind-param encoding (blobs and
 * tagged BigInts), and outbound row decoding.
 */
export interface NativeSql {
  open(payload: OpenPayload): Promise<OpenedNativeConnection>;
  close(dbId: string): Promise<void>;
  execute(dbId: string, sql: string, params?: BindValues): Promise<RawQueryResult>;
  executeBatch(dbId: string, sql: string, params?: BindValueRows): Promise<QueryResult<never>>;
}

export const nativeSql: NativeSql = {
  async open(payload) {
    const envelope = await withNativeCallback((callback) =>
      getNativeModule().open(payload, callback),
    );
    if (envelope.dbId == null) {
      throw new Error("NativePowerSyncModule.open did not return dbId");
    }
    return { dbId: envelope.dbId, multiTab: envelope.multiTab === true };
  },
  async close(dbId) {
    await withNativeCallback((callback) => getNativeModule().close(dbId, callback));
  },
  async execute(dbId, sql, params) {
    const encoded = encodeBindParams(params);
    const envelope = await withNativeCallback((callback) =>
      getNativeModule().execute(dbId, sql, encoded, callback),
    );
    return {
      insertId: envelope.insertId,
      rowsAffected: envelope.rowsAffected,
      columnNames: envelope.columnNames ?? [],
      rawRows: decodeRawRows(envelope.rawRows),
    };
  },
  async executeBatch(dbId, sql, params) {
    const encoded = encodeBindParamRows(params);
    const envelope = await withNativeCallback((callback) =>
      getNativeModule().executeBatch(dbId, sql, encoded, callback),
    );
    return queryResultWithoutRows({
      rowsAffected: envelope.rowsAffected ?? 0,
    });
  },
};
