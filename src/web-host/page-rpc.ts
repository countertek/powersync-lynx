import {
  asCloneableObject,
  decodeCloneable,
  encodeCloneable,
  type Cloneable,
  type CloneableObject,
} from "./cloneable.ts";
import { copyToArrayBuffer, errorCode, hasPrimitiveConstructor } from "../values.ts";
import type { NativeEnvelope, NativeFailEnvelope, NativeOkEnvelope } from "../adapter/native.ts";

export const MODULE_NAME = "NativePowerSyncModule";

const ATTACH_OPTION_KEYS = [
  "vfs",
  "useWebWorker",
  "enableMultiTabs",
  "worker",
  "additionalReaders",
  "temporaryStorage",
  "cacheSizeKb",
  "databaseWorkerLogLevel",
  "disableSSRWarning",
] as const;

export type AttachOptionKey = (typeof ATTACH_OPTION_KEYS)[number];

export interface WASQLiteWorkerFactoryOptions {
  readonly name?: string;
}

export type WASQLiteWorkerFactory = (
  options: WASQLiteWorkerFactoryOptions,
) => Worker | SharedWorker;

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
  log(record: { level: number; message: string }): void;
}

export interface PowerSyncWebModule {
  WASQLiteOpenFactory: new (options: {
    open: WASQLiteOpenFields;
    logger: PowerSyncLoggerLike;
  }) => WASQLiteFactoryHandle;
  createConsoleLogger?: (options: { prefix: string }) => PowerSyncLoggerLike;
}

export type LoadWeb = () => Promise<PowerSyncWebModule>;

export interface WASQLiteQueryResult {
  insertId?: number;
  rowsAffected?: number;
  columnNames?: string[];
  rawRows?: Cloneable[][];
  array?: CloneableObject[];
  rows?: { _array?: CloneableObject[] } | CloneableObject[];
}

interface FileEntry {
  refCount: number;
  adapter: WASQLiteAdapter | null;
  pending: Promise<void> | null;
}

interface ConnectionEntry {
  fileKey: string;
  readOnly: boolean;
}

const files = new Map<string, FileEntry>();
const connections = new Map<string, ConnectionEntry>();
let nextDbId = 0;

export function fileKey(dbFilename: string, dbLocation?: string): string {
  return `${dbFilename}\0${dbLocation ?? ""}`;
}

export function resetWebHostMapping(): void {
  files.clear();
  connections.clear();
  nextDbId = 0;
}

export interface MappingStats {
  files: number;
  connections: number;
}

export function mappingStats(): MappingStats {
  return {
    files: files.size,
    connections: connections.size,
  };
}

interface CatchErrorFields {
  message?: string;
  code?: number;
}

function failure(err: Error | CatchErrorFields | string): NativeFailEnvelope {
  const message =
    err instanceof Error
      ? err.message
      : err instanceof Object && err.message != null
        ? String(err.message)
        : String(err);
  const result: NativeFailEnvelope = { ok: false, message };
  if (err instanceof Object) {
    const code = errorCode(err);
    if (code !== undefined) result.code = code;
  }
  return result;
}

function pickAttachOpenFields(attachOptions?: AttachOptions): AttachOptions {
  const open: AttachOptions = {};
  if (!attachOptions) {
    return open;
  }
  for (const key of ATTACH_OPTION_KEYS) {
    const value = attachOptions[key];
    if (value !== undefined) {
      assignAttachOption(open, key, value);
    }
  }
  return open;
}

function assignAttachOption(
  open: AttachOptions,
  key: AttachOptionKey,
  value: AttachOptions[AttachOptionKey],
): void {
  switch (key) {
    case "vfs":
      if (hasPrimitiveConstructor(value, String)) open.vfs = value;
      break;
    case "useWebWorker":
      if (hasPrimitiveConstructor(value, Boolean)) open.useWebWorker = value;
      break;
    case "enableMultiTabs":
      if (hasPrimitiveConstructor(value, Boolean)) open.enableMultiTabs = value;
      break;
    case "worker":
      if (
        value !== undefined &&
        !hasPrimitiveConstructor(value, Boolean) &&
        !hasPrimitiveConstructor(value, Number)
      ) {
        open.worker = value;
      }
      break;
    case "additionalReaders":
      if (hasPrimitiveConstructor(value, Number)) open.additionalReaders = value;
      break;
    case "temporaryStorage":
      if (hasPrimitiveConstructor(value, String)) open.temporaryStorage = value;
      break;
    case "cacheSizeKb":
      if (hasPrimitiveConstructor(value, Number)) open.cacheSizeKb = value;
      break;
    case "databaseWorkerLogLevel":
      if (hasPrimitiveConstructor(value, Number)) open.databaseWorkerLogLevel = value;
      break;
    case "disableSSRWarning":
      if (hasPrimitiveConstructor(value, Boolean)) open.disableSSRWarning = value;
      break;
  }
}

/** wa-sqlite bind() accepts Uint8Array | number[] for blobs; ArrayBuffer is bound as NULL. */
function toSqliteBind(value: Cloneable): WASQLiteBindValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

function toSqliteParams(params: Cloneable): WASQLiteBindValue {
  if (!Array.isArray(params)) {
    return params;
  }
  return params.map((item) => (Array.isArray(item) ? item.map(toSqliteBind) : toSqliteBind(item)));
}

/** executeRaw cells are Uint8Array; native BindValue / encodeCloneable require ArrayBuffer. */
function toNativeCell(value: Cloneable): Cloneable {
  if (value instanceof Uint8Array) {
    return copyToArrayBuffer(value);
  }
  return value;
}

function toNativeEnvelope(result: WASQLiteQueryResult): NativeOkEnvelope {
  if (result && Array.isArray(result.rawRows) && Array.isArray(result.columnNames)) {
    return {
      ok: true,
      insertId: result.insertId ?? 0,
      rowsAffected: result.rowsAffected ?? 0,
      columnNames: result.columnNames,
      // SAFETY: toNativeCell keeps SQLite cells as NativeCell or ArrayBuffer blobs for the native envelope.
      rawRows: result.rawRows.map((row) =>
        Array.isArray(row) ? row.map(toNativeCell) : row,
      ) as NativeOkEnvelope["rawRows"],
    };
  }
  const rowsFromArray = result.array;
  const rowsFromDeprecated =
    result.rows instanceof Object && !Array.isArray(result.rows) ? result.rows._array : undefined;
  const rowsFromArrayish = Array.isArray(result.rows) ? result.rows : undefined;
  const rows = rowsFromArray ?? rowsFromDeprecated ?? rowsFromArrayish ?? [];
  const first = rows[0];
  const columnNames = first instanceof Object && !Array.isArray(first) ? Object.keys(first) : [];
  const rawRows = columnNames.length
    ? rows.map((row) => {
        const record = row instanceof Object && !Array.isArray(row) ? row : asCloneableObject({});
        return columnNames.map((name) => toNativeCell(record[name]));
      })
    : [];
  return {
    ok: true,
    insertId: result.insertId ?? 0,
    rowsAffected: result.rowsAffected ?? 0,
    columnNames,
    // SAFETY: mapped WASQLite rows are NativeCell/ArrayBuffer cells for the native envelope.
    rawRows: rawRows as NativeOkEnvelope["rawRows"],
  };
}

async function loadWebModule(loadWeb: LoadWeb): Promise<PowerSyncWebModule> {
  const web = await loadWeb();
  if (web.WASQLiteOpenFactory == null) {
    throw new Error("@powersync/web WASQLiteOpenFactory is required");
  }
  return web;
}

async function openFile(
  fileKeyValue: string,
  dbFilename: string,
  dbLocation: string | undefined,
  attachOptions: AttachOptions | undefined,
  loadWeb: LoadWeb,
): Promise<FileEntry> {
  let entry = files.get(fileKeyValue);
  if (entry?.adapter) {
    entry.refCount += 1;
    return entry;
  }
  if (entry?.pending) {
    await entry.pending;
    if (!entry.adapter) {
      throw new Error(`WASQLite open failed for ${dbFilename}`);
    }
    entry.refCount += 1;
    return entry;
  }

  entry = { refCount: 0, adapter: null, pending: null };
  files.set(fileKeyValue, entry);
  const opening = entry;
  opening.pending = (async () => {
    const web = await loadWebModule(loadWeb);
    const logger =
      web.createConsoleLogger instanceof Function
        ? web.createConsoleLogger({ prefix: "powersync-lynx" })
        : { log() {} };
    const open: WASQLiteOpenFields = {
      dbFilename,
      ...pickAttachOpenFields(attachOptions),
    };
    if (dbLocation != null && dbLocation !== "") {
      open.dbLocation = dbLocation;
    }
    const factory = new web.WASQLiteOpenFactory({ open, logger });
    let adapter: WASQLiteAdapter | Promise<WASQLiteAdapter> = factory.openDB();
    if (adapter instanceof Promise) {
      adapter = await adapter;
    }
    opening.adapter = adapter;
  })();
  try {
    await opening.pending;
  } catch (err) {
    files.delete(fileKeyValue);
    throw err;
  } finally {
    opening.pending = null;
  }
  if (!opening.adapter) {
    files.delete(fileKeyValue);
    throw new Error(`WASQLite open failed for ${dbFilename}`);
  }
  opening.refCount += 1;
  return opening;
}

interface OpenRequest {
  dbFilename?: string;
  dbLocation?: string;
  dbId?: string;
  readOnly?: boolean;
}

interface ExecuteRequest {
  dbId?: string;
  sql?: string;
  params?: Cloneable;
}

function asOpenRequest(data: Cloneable): OpenRequest {
  if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
    // SAFETY: Native Module open/close payloads are JSON-like OpenRequest records.
    return data as OpenRequest;
  }
  return {};
}

async function dispatchOpen(
  data: Cloneable,
  attachOptions: AttachOptions | undefined,
  loadWeb: LoadWeb,
): Promise<NativeEnvelope> {
  const request = asOpenRequest(data);
  const dbFilename = request.dbFilename;
  if (!hasPrimitiveConstructor(dbFilename, String) || dbFilename.length === 0) {
    return { ok: false, message: "open requires dbFilename" };
  }
  const dbLocation = hasPrimitiveConstructor(request.dbLocation, String)
    ? request.dbLocation
    : undefined;
  const key = fileKey(dbFilename, dbLocation);
  await openFile(key, dbFilename, dbLocation, attachOptions, loadWeb);
  const dbId = `ps-${++nextDbId}`;
  connections.set(dbId, { fileKey: key, readOnly: request.readOnly === true });
  return { ok: true, dbId };
}

async function dispatchClose(data: Cloneable): Promise<NativeEnvelope> {
  const request = asOpenRequest(data);
  const dbId = hasPrimitiveConstructor(data, String)
    ? data
    : hasPrimitiveConstructor(request.dbId, String)
      ? request.dbId
      : undefined;
  if (!hasPrimitiveConstructor(dbId, String) || !connections.has(dbId)) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const conn = connections.get(dbId);
  if (conn == null) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  connections.delete(dbId);
  const entry = files.get(conn.fileKey);
  if (entry) {
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      files.delete(conn.fileKey);
      await entry.adapter?.close?.();
    }
  }
  return { ok: true };
}

async function withLock<T>(
  adapter: WASQLiteAdapter,
  readOnly: boolean,
  fn: (tx: WASQLiteTx) => Promise<T>,
): Promise<T> {
  if (readOnly) {
    return adapter.readLock(fn);
  }
  return adapter.writeLock(fn);
}

function asExecuteRequest(data: Cloneable): ExecuteRequest {
  if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
    // SAFETY: Native Module execute payloads are JSON-like ExecuteRequest records.
    return data as ExecuteRequest;
  }
  return {};
}

async function dispatchExecute(data: Cloneable): Promise<NativeEnvelope> {
  const request = asExecuteRequest(data);
  const dbId = request.dbId;
  if (!hasPrimitiveConstructor(dbId, String)) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const conn = connections.get(dbId);
  if (!conn) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const entry = files.get(conn.fileKey);
  if (!entry?.adapter) {
    return { ok: false, message: `closed dbId: ${dbId}` };
  }
  const sql = request.sql;
  if (!hasPrimitiveConstructor(sql, String)) {
    return { ok: false, message: "execute requires sql" };
  }
  const params = toSqliteParams(request.params ?? []);
  const result = await withLock(entry.adapter, conn.readOnly, (tx) => tx.executeRaw(sql, params));
  return toNativeEnvelope(result);
}

async function dispatchExecuteBatch(data: Cloneable): Promise<NativeEnvelope> {
  const request = asExecuteRequest(data);
  const dbId = request.dbId;
  if (!hasPrimitiveConstructor(dbId, String)) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const conn = connections.get(dbId);
  if (!conn) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const entry = files.get(conn.fileKey);
  if (!entry?.adapter) {
    return { ok: false, message: `closed dbId: ${dbId}` };
  }
  const sql = request.sql;
  if (!hasPrimitiveConstructor(sql, String)) {
    return { ok: false, message: "executeBatch requires sql" };
  }
  const params = toSqliteParams(request.params ?? []);
  const result = await withLock(entry.adapter, conn.readOnly, (tx) =>
    conn.readOnly ? tx.executeRaw(sql, params) : tx.executeBatch(sql, params),
  );
  return toNativeEnvelope(result);
}

function envelopeToCloneable(result: NativeEnvelope): Cloneable {
  if (result.ok === false) {
    if (result.code === undefined) {
      return { ok: false, message: result.message };
    }
    return { ok: false, message: result.message, code: result.code };
  }
  const rawRows = result.rawRows?.map((row) =>
    row.map((cell) => (cell instanceof Uint8Array ? copyToArrayBuffer(cell) : cell)),
  );
  return {
    ok: true,
    dbId: result.dbId,
    insertId: result.insertId,
    rowsAffected: result.rowsAffected,
    columnNames: result.columnNames,
    rawRows,
  };
}

export async function handleNativeCall(
  name: string,
  encodedData: Cloneable,
  attachOptions: AttachOptions | undefined,
  loadWeb: LoadWeb,
): Promise<Cloneable> {
  const data = decodeCloneable(encodedData);
  try {
    let result: NativeEnvelope;
    switch (name) {
      case "open":
        result = await dispatchOpen(data, attachOptions, loadWeb);
        break;
      case "close":
        result = await dispatchClose(data);
        break;
      case "execute":
        result = await dispatchExecute(data);
        break;
      case "executeBatch":
        result = await dispatchExecuteBatch(data);
        break;
      default:
        result = { ok: false, message: `unknown method: ${name}` };
    }
    return encodeCloneable(envelopeToCloneable(result));
  } catch (err) {
    if (err instanceof Error) {
      return encodeCloneable(envelopeToCloneable(failure(err)));
    }
    if (err instanceof Object) {
      return encodeCloneable(envelopeToCloneable(failure(err)));
    }
    return encodeCloneable(envelopeToCloneable(failure(String(err))));
  }
}

export type NativeModulesCallHandler = (
  name: string,
  data: Cloneable,
  moduleName: string,
) => Cloneable | Promise<Cloneable | undefined> | undefined;

export function createOnNativeModulesCall(
  previous: NativeModulesCallHandler | null | undefined,
  attachOptions: AttachOptions | undefined,
  loadWeb: LoadWeb,
): NativeModulesCallHandler {
  return async function onNativeModulesCall(name, data, moduleName) {
    if (moduleName !== MODULE_NAME) {
      return previous?.(name, data, moduleName);
    }
    return handleNativeCall(name, data, attachOptions, loadWeb);
  };
}
