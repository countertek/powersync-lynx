import {
  asCloneableObject,
  decodeCloneable,
  encodeCloneable,
  type Cloneable,
  type CloneableObject,
} from "./cloneable.ts";
import { isBoolean, isNumber, isString } from "../type-guards.ts";
import { copyToArrayBuffer, failEnvelopeFromError } from "../values.ts";
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
  pendingTables: string[];
}

interface HeldLease {
  tx: WASQLiteTx;
  release(): Promise<void>;
}

interface ConnectionEntry {
  fileKey: string;
  readOnly: boolean;
  lease: HeldLease | null;
  tail: Promise<void>;
}

export function fileKey(dbFilename: string, dbLocation?: string): string {
  return `${dbFilename}\0${dbLocation ?? ""}`;
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
      if (isString(value)) open.vfs = value;
      break;
    case "useWebWorker":
      if (isBoolean(value)) open.useWebWorker = value;
      break;
    case "enableMultiTabs":
      if (isBoolean(value)) open.enableMultiTabs = value;
      break;
    case "worker":
      if (value !== undefined && !isBoolean(value) && !isNumber(value)) {
        open.worker = value;
      }
      break;
    case "additionalReaders":
      if (isNumber(value)) open.additionalReaders = value;
      break;
    case "temporaryStorage":
      if (isString(value)) open.temporaryStorage = value;
      break;
    case "cacheSizeKb":
      if (isNumber(value)) open.cacheSizeKb = value;
      break;
    case "databaseWorkerLogLevel":
      if (isNumber(value)) open.databaseWorkerLogLevel = value;
      break;
    case "disableSSRWarning":
      if (isBoolean(value)) open.disableSSRWarning = value;
      break;
  }
}

interface SafariWindow {
  safari?: object;
}

/**
 * Whether WASQLite shares this file between tabs: the host's `enableMultiTabs`,
 * else the same default `@powersync/web` resolves for an omitted flag.
 */
function sharesFileBetweenTabs(attachOptions: AttachOptions | undefined): boolean {
  const requested = attachOptions?.enableMultiTabs;
  if (isBoolean(requested)) {
    return requested;
  }
  if (globalThis.navigator == null || globalThis.SharedWorker == null) {
    return false;
  }
  // SAFETY: Safari exposes a non-standard `safari` object on the page global.
  const page = globalThis as SafariWindow;
  return !/(Android|iPhone|iPod|iPad)/i.test(navigator.userAgent) && page.safari == null;
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

interface ResolvedExecute {
  ok: true;
  conn: ConnectionEntry;
  entry: FileEntry;
  adapter: WASQLiteAdapter;
  sql: string;
  params: WASQLiteBindValue;
}

function asOpenRequest(data: Cloneable): OpenRequest {
  if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
    // SAFETY: Native Module open/close payloads are JSON-like OpenRequest records.
    return data as OpenRequest;
  }
  return {};
}

function isUpdateHooksGet(sql: string): boolean {
  return /powersync_update_hooks\s*\(\s*'get'\s*\)/i.test(sql);
}

function tablesFromJsonCell(cell: Cloneable | undefined): string[] {
  if (cell == null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(String(cell));
    if (!Array.isArray(parsed)) {
      return [];
    }
    const tables: string[] = [];
    for (const item of parsed) {
      if (isString(item)) {
        tables.push(item);
      }
    }
    return tables;
  } catch {
    return [];
  }
}

function addPendingTables(entry: FileEntry, tables: string[]): void {
  for (const table of tables) {
    if (!entry.pendingTables.includes(table)) {
      entry.pendingTables.push(table);
    }
  }
}

async function stashUpdateHooks(tx: WASQLiteTx, entry: FileEntry | undefined): Promise<void> {
  if (entry == null) {
    return;
  }
  try {
    // WASQLite writeLock can drain powersync_update_hooks before the Adapter's
    // follow-up get; stash names here and merge them in mergeHookGetEnvelope.
    const result = await tx.executeRaw("SELECT powersync_update_hooks('get')", []);
    addPendingTables(entry, tablesFromJsonCell(result.rawRows?.[0]?.[0]));
  } catch {
    // PRAGMAs can run before sqlite-core hooks exist on a mock or fresh connection.
  }
}

function takePendingTables(entry: FileEntry, extra: string[]): string[] {
  const merged: string[] = [];
  for (const table of [...entry.pendingTables, ...extra]) {
    if (!merged.includes(table)) {
      merged.push(table);
    }
  }
  entry.pendingTables = [];
  return merged;
}

function mergeHookGetEnvelope(
  entry: FileEntry | undefined,
  result: NativeOkEnvelope,
): NativeOkEnvelope {
  if (entry == null) {
    return result;
  }
  const tables = takePendingTables(entry, tablesFromJsonCell(result.rawRows?.[0]?.[0]));
  return {
    ...result,
    columnNames: ["powersync_update_hooks"],
    rawRows: [[JSON.stringify(tables)]],
  };
}

async function withLock<T>(
  adapter: WASQLiteAdapter,
  readOnly: boolean,
  fn: (tx: WASQLiteTx) => Promise<T>,
  entry?: FileEntry,
): Promise<T> {
  if (readOnly) {
    return adapter.readLock(fn);
  }
  return adapter.writeLock(async (tx) => {
    try {
      return await fn(tx);
    } finally {
      await stashUpdateHooks(tx, entry);
    }
  });
}

function asExecuteRequest(data: Cloneable): ExecuteRequest {
  if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
    // SAFETY: Native Module execute payloads are JSON-like ExecuteRequest records.
    return data as ExecuteRequest;
  }
  return {};
}

function transactionControl(sql: string): "begin" | "commit" | "rollback" | null {
  const trimmed = sql.trim();
  const ended = trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
  const upper = ended.toUpperCase();
  if (upper === "BEGIN" || upper.startsWith("BEGIN ")) {
    return "begin";
  }
  if (
    upper === "COMMIT" ||
    upper === "END" ||
    upper.startsWith("COMMIT ") ||
    upper.startsWith("END ")
  ) {
    return "commit";
  }
  if (upper === "ROLLBACK" || upper.startsWith("ROLLBACK ")) {
    if (upper.startsWith("ROLLBACK TO")) {
      return null;
    }
    return "rollback";
  }
  return null;
}

async function enqueueConnection<T>(conn: ConnectionEntry, run: () => Promise<T>): Promise<T> {
  const previous = conn.tail;
  let releaseQueue = (): void => {};
  conn.tail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    releaseQueue();
  }
}

async function acquireHeldLease(
  adapter: WASQLiteAdapter,
  readOnly: boolean,
  entry?: FileEntry,
): Promise<HeldLease> {
  let releaseLock = (): void => {};
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let settleTx: ((tx: WASQLiteTx) => void) | undefined;
  let failTx: ((reason: Error) => void) | undefined;
  const ready = new Promise<WASQLiteTx>((resolve, reject) => {
    settleTx = resolve;
    failTx = reject;
  });
  const finished = withLock(
    adapter,
    readOnly,
    async (tx) => {
      if (settleTx) {
        settleTx(tx);
      }
      await held;
    },
    entry,
  );
  finished.catch((reason: Error) => {
    if (failTx) {
      failTx(reason);
    }
  });
  const tx = await ready;
  return {
    tx,
    async release() {
      releaseLock();
      await finished;
    },
  };
}

async function abortHeldLease(conn: ConnectionEntry): Promise<void> {
  const lease = conn.lease;
  if (lease == null) {
    return;
  }
  conn.lease = null;
  try {
    await lease.tx.executeRaw("ROLLBACK", []);
  } catch {
    // The statement had no transaction, or lock recovery already rolled it back.
  }
  await lease.release();
}

function envelopeToCloneable(result: NativeEnvelope): Cloneable {
  if (result.ok === false) {
    if (result.code === undefined) {
      return { ok: false, message: result.message };
    }
    return { ok: false, message: result.message, code: result.code };
  }
  return {
    ok: true,
    dbId: result.dbId,
    multiTab: result.multiTab,
    insertId: result.insertId,
    rowsAffected: result.rowsAffected,
    columnNames: result.columnNames,
    rawRows: result.rawRows,
  };
}

export type NativeModulesCallHandler = (
  name: string,
  data: Cloneable,
  moduleName: string,
) => Cloneable | Promise<Cloneable | undefined> | undefined;

export class WebHostSqlBridge {
  private readonly files = new Map<string, FileEntry>();
  private readonly connections = new Map<string, ConnectionEntry>();
  private nextDbId = 0;
  private readonly attachOptions: AttachOptions | undefined;
  private readonly loadWeb: LoadWeb;

  constructor(attachOptions: AttachOptions | undefined, loadWeb: LoadWeb) {
    this.attachOptions = attachOptions;
    this.loadWeb = loadWeb;
  }

  async handleCall(name: string, encodedData: Cloneable): Promise<Cloneable> {
    try {
      const data = decodeCloneable(encodedData);
      let result: NativeEnvelope;
      switch (name) {
        case "open":
          result = await this.dispatchOpen(data);
          break;
        case "close":
          result = await this.dispatchClose(data);
          break;
        case "execute":
          result = await this.dispatchExecute(data);
          break;
        case "executeBatch":
          result = await this.dispatchExecuteBatch(data);
          break;
        default:
          result = { ok: false, message: `unknown method: ${name}` };
      }
      return encodeCloneable(envelopeToCloneable(result));
    } catch (err) {
      return encodeCloneable(envelopeToCloneable(failEnvelopeFromError(err)));
    }
  }

  createHandler(previous?: NativeModulesCallHandler | null): NativeModulesCallHandler {
    return async (name, data, moduleName) => {
      if (moduleName !== MODULE_NAME) {
        return previous?.(name, data, moduleName);
      }
      return this.handleCall(name, data);
    };
  }

  private async openFile(
    fileKeyValue: string,
    dbFilename: string,
    dbLocation: string | undefined,
  ): Promise<FileEntry> {
    let entry = this.files.get(fileKeyValue);
    if (entry?.pending) {
      await entry.pending;
      entry = this.files.get(fileKeyValue);
    }
    if (entry?.adapter) {
      entry.refCount += 1;
      return entry;
    }

    entry = { refCount: 0, adapter: null, pending: null, pendingTables: [] };
    this.files.set(fileKeyValue, entry);
    const opening = entry;
    opening.pending = (async () => {
      const web = await loadWebModule(this.loadWeb);
      const logger =
        web.createConsoleLogger instanceof Function
          ? web.createConsoleLogger({ prefix: "powersync-lynx" })
          : { log() {} };
      const open: WASQLiteOpenFields = {
        dbFilename,
        ...pickAttachOpenFields(this.attachOptions),
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
      if (this.files.get(fileKeyValue) === opening) {
        this.files.delete(fileKeyValue);
      }
      throw err;
    } finally {
      opening.pending = null;
    }
    if (!opening.adapter) {
      if (this.files.get(fileKeyValue) === opening) {
        this.files.delete(fileKeyValue);
      }
      throw new Error(`WASQLite open failed for ${dbFilename}`);
    }
    opening.refCount += 1;
    return opening;
  }

  private async dispatchOpen(data: Cloneable): Promise<NativeEnvelope> {
    const request = asOpenRequest(data);
    const dbFilename = request.dbFilename;
    if (!isString(dbFilename) || dbFilename.length === 0) {
      return { ok: false, message: "open requires dbFilename" };
    }
    const dbLocation = isString(request.dbLocation) ? request.dbLocation : undefined;
    const key = fileKey(dbFilename, dbLocation);
    await this.openFile(key, dbFilename, dbLocation);
    const dbId = `ps-${++this.nextDbId}`;
    this.connections.set(dbId, {
      fileKey: key,
      readOnly: request.readOnly === true,
      lease: null,
      tail: Promise.resolve(),
    });
    if (sharesFileBetweenTabs(this.attachOptions)) {
      return { ok: true, dbId, multiTab: true };
    }
    return { ok: true, dbId };
  }

  private async dispatchClose(data: Cloneable): Promise<NativeEnvelope> {
    const request = asOpenRequest(data);
    const dbId = isString(data) ? data : isString(request.dbId) ? request.dbId : undefined;
    if (!isString(dbId) || !this.connections.has(dbId)) {
      return { ok: false, message: `unknown dbId: ${dbId}` };
    }
    const conn = this.connections.get(dbId);
    if (conn == null) {
      return { ok: false, message: `unknown dbId: ${dbId}` };
    }
    return enqueueConnection(conn, async () => {
      if (this.connections.get(dbId) !== conn) {
        return { ok: false, message: `unknown dbId: ${dbId}` };
      }
      await abortHeldLease(conn);
      const entry = this.files.get(conn.fileKey);
      if (entry == null) {
        this.connections.delete(dbId);
        return { ok: true };
      }
      if (entry.refCount > 1) {
        this.connections.delete(dbId);
        entry.refCount -= 1;
        return { ok: true };
      }
      const adapter = entry.adapter;
      if (adapter == null) {
        this.dropClosedFile(dbId, conn, entry);
        return { ok: true };
      }
      const closing = Promise.resolve(adapter.close()).then(() => undefined);
      entry.pending = closing;
      try {
        await closing;
        this.dropClosedFile(dbId, conn, entry);
        return { ok: true };
      } catch (err) {
        return failEnvelopeFromError(err);
      } finally {
        if (entry.pending === closing) {
          entry.pending = null;
        }
      }
    });
  }

  private dropClosedFile(dbId: string, conn: ConnectionEntry, entry: FileEntry): void {
    this.connections.delete(dbId);
    entry.refCount -= 1;
    entry.adapter = null;
    if (this.files.get(conn.fileKey) === entry && entry.refCount <= 0 && entry.adapter == null) {
      this.files.delete(conn.fileKey);
    }
  }

  private resolveExecute(
    data: Cloneable,
    method: "execute" | "executeBatch",
  ): ResolvedExecute | NativeFailEnvelope {
    const request = asExecuteRequest(data);
    const dbId = request.dbId;
    if (!isString(dbId)) {
      return { ok: false, message: `unknown dbId: ${dbId}` };
    }
    const conn = this.connections.get(dbId);
    if (!conn) {
      return { ok: false, message: `unknown dbId: ${dbId}` };
    }
    const entry = this.files.get(conn.fileKey);
    if (!entry?.adapter) {
      return { ok: false, message: `closed dbId: ${dbId}` };
    }
    const sql = request.sql;
    if (!isString(sql)) {
      return { ok: false, message: `${method} requires sql` };
    }
    return {
      ok: true,
      conn,
      entry,
      adapter: entry.adapter,
      sql,
      params: toSqliteParams(request.params ?? []),
    };
  }

  private async executeOnHeldOrLock(
    adapter: WASQLiteAdapter,
    conn: ConnectionEntry,
    sql: string,
    params: WASQLiteBindValue,
  ): Promise<NativeOkEnvelope> {
    const entry = this.files.get(conn.fileKey);
    const control = transactionControl(sql);
    let envelope: NativeOkEnvelope;
    if (control === "begin") {
      const started = conn.lease == null;
      if (started) {
        conn.lease = await acquireHeldLease(adapter, conn.readOnly, entry);
      }
      const lease = conn.lease;
      if (lease == null) {
        throw new Error("failed to acquire WASQLite lease");
      }
      try {
        const result = await lease.tx.executeRaw(sql, params);
        envelope = toNativeEnvelope(result);
      } catch (failure) {
        if (started) {
          await abortHeldLease(conn);
        }
        throw failure;
      }
    } else if (control === "commit" || control === "rollback") {
      const lease = conn.lease;
      if (lease == null) {
        const result = await withLock(
          adapter,
          conn.readOnly,
          (tx) => tx.executeRaw(sql, params),
          entry,
        );
        envelope = toNativeEnvelope(result);
      } else {
        try {
          const result = await lease.tx.executeRaw(sql, params);
          envelope = toNativeEnvelope(result);
        } finally {
          conn.lease = null;
          await lease.release();
        }
      }
    } else if (conn.lease != null) {
      const result = await conn.lease.tx.executeRaw(sql, params);
      envelope = toNativeEnvelope(result);
    } else {
      const result = await withLock(
        adapter,
        conn.readOnly,
        (tx) => tx.executeRaw(sql, params),
        entry,
      );
      envelope = toNativeEnvelope(result);
    }
    if (isUpdateHooksGet(sql) && conn.readOnly !== true) {
      return mergeHookGetEnvelope(entry, envelope);
    }
    return envelope;
  }

  private async dispatchExecute(data: Cloneable): Promise<NativeEnvelope> {
    const resolved = this.resolveExecute(data, "execute");
    if (!resolved.ok) {
      return resolved;
    }
    return enqueueConnection(resolved.conn, () =>
      this.executeOnHeldOrLock(resolved.adapter, resolved.conn, resolved.sql, resolved.params),
    );
  }

  private async dispatchExecuteBatch(data: Cloneable): Promise<NativeEnvelope> {
    const resolved = this.resolveExecute(data, "executeBatch");
    if (!resolved.ok) {
      return resolved;
    }
    const { conn, entry, adapter, sql, params } = resolved;
    return enqueueConnection(conn, async () => {
      if (conn.lease != null) {
        const result = conn.readOnly
          ? await conn.lease.tx.executeRaw(sql, params)
          : await conn.lease.tx.executeBatch(sql, params);
        return toNativeEnvelope(result);
      }
      const result = await withLock(
        adapter,
        conn.readOnly,
        async (tx) => {
          if (conn.readOnly) {
            return tx.executeRaw(sql, params);
          }
          await tx.executeRaw("BEGIN IMMEDIATE", []);
          try {
            const batchResult = await tx.executeBatch(sql, params);
            await tx.executeRaw("COMMIT", []);
            return batchResult;
          } catch (failure) {
            try {
              await tx.executeRaw("ROLLBACK", []);
            } catch {
              // Batch already failed; keep the original error.
            }
            throw failure;
          }
        },
        entry,
      );
      return toNativeEnvelope(result);
    });
  }
}
