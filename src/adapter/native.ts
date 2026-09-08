import type { SqliteValue } from "@powersync/common";
import { copyToArrayBuffer, isNumberArray } from "../values.ts";

export type BindValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | ArrayBuffer
  | Uint8Array
  | readonly number[];

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

export class NativeModuleError extends Error {
  code?: number;
}

function getNativeModule(): NativePowerSyncModule {
  const modules = globalThis.NativeModules;
  const native = modules?.NativePowerSyncModule;
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

export function callNative(method: "open", payload: OpenPayload): Promise<NativeOkEnvelope>;
export function callNative(method: "close", dbId: string): Promise<NativeOkEnvelope>;
export function callNative(
  method: "execute",
  dbId: string,
  sql: string,
  params: BindValues,
): Promise<NativeOkEnvelope>;
export function callNative(
  method: "executeBatch",
  dbId: string,
  sql: string,
  params: BindValueRows,
): Promise<NativeOkEnvelope>;
export function callNative(
  method: "open" | "close" | "execute" | "executeBatch",
  first?: OpenPayload | string,
  sql?: string,
  params?: BindValues | BindValueRows,
): Promise<NativeOkEnvelope> {
  const native = getNativeModule();
  switch (method) {
    case "open":
      // SAFETY: open overload requires OpenPayload as the first argument.
      return withNativeCallback((callback) => native.open(first as OpenPayload, callback));
    case "close":
      // SAFETY: close overload requires dbId string as the first argument.
      return withNativeCallback((callback) => native.close(first as string, callback));
    case "execute":
      // SAFETY: execute overload is (dbId, sql, BindValues).
      return withNativeCallback((callback) =>
        native.execute(first as string, sql as string, params as BindValues, callback),
      );
    case "executeBatch":
      // SAFETY: executeBatch overload is (dbId, sql, BindValueRows).
      return withNativeCallback((callback) =>
        native.executeBatch(first as string, sql as string, params as BindValueRows, callback),
      );
  }
}

export function blobToArrayBuffer(value: BindValue): BindValue {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return copyToArrayBuffer(value);
  }
  if (Array.isArray(value) && isNumberArray(value)) {
    return copyToArrayBuffer(Uint8Array.from(value));
  }
  return value;
}

export function encodeBindParams(params: BindValues | null | undefined): BindValue[] {
  if (params == null) {
    return [];
  }
  return params.map(blobToArrayBuffer);
}

export function encodeBindParamRows(params: BindValueRows | null | undefined): BindValue[][] {
  if (params == null) {
    return [];
  }
  return params.map(encodeBindParams);
}

export function decodeCell(value: NativeCell): SqliteValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

export function decodeRawRows(rawRows: NativeCell[][] | null | undefined): SqliteValue[][] {
  return (rawRows ?? []).map((row) => (row ?? []).map(decodeCell));
}
