import { decodeCloneable, encodeCloneable } from './cloneable.js';

export const MODULE_NAME = 'NativePowerSyncModule';

const ATTACH_OPTION_KEYS = [
  'vfs',
  'useWebWorker',
  'enableMultiTabs',
  'worker',
  'additionalReaders',
  'temporaryStorage',
  'cacheSizeKb',
  'databaseWorkerLogLevel',
  'disableSSRWarning'
];

/** @type {Map<string, FileEntry>} */
const files = new Map();
/** @type {Map<string, { fileKey: string, readOnly: boolean }>} */
const connections = new Map();
let nextDbId = 0;

/**
 * @typedef {object} FileEntry
 * @property {number} refCount
 * @property {unknown} adapter
 * @property {Promise<void> | null} pending
 */

export function fileKey(dbFilename, dbLocation) {
  return `${dbFilename}\0${dbLocation ?? ''}`;
}

export function resetWebHostMapping() {
  files.clear();
  connections.clear();
  nextDbId = 0;
}

export function mappingStats() {
  return {
    files: files.size,
    connections: connections.size
  };
}

function failure(err) {
  const message =
    err && typeof err === 'object' && 'message' in err && err.message != null
      ? String(err.message)
      : String(err);
  const result = { ok: false, message };
  if (err && typeof err === 'object' && typeof err.code === 'number') {
    result.code = err.code;
  }
  return result;
}

function pickAttachOpenFields(attachOptions) {
  const open = {};
  if (!attachOptions) {
    return open;
  }
  for (const key of ATTACH_OPTION_KEYS) {
    if (attachOptions[key] !== undefined) {
      open[key] = attachOptions[key];
    }
  }
  return open;
}

/** wa-sqlite bind() accepts Uint8Array | number[] for blobs; ArrayBuffer is bound as NULL. */
function toSqliteBind(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

function toSqliteParams(params) {
  if (!Array.isArray(params)) {
    return params;
  }
  return params.map((item) => (Array.isArray(item) ? item.map(toSqliteBind) : toSqliteBind(item)));
}

/** executeRaw cells are Uint8Array; native BindValue / encodeCloneable require ArrayBuffer. */
function toNativeCell(value) {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

function toNativeEnvelope(result) {
  if (result && Array.isArray(result.rawRows) && Array.isArray(result.columnNames)) {
    return {
      ok: true,
      insertId: result.insertId ?? 0,
      rowsAffected: result.rowsAffected ?? 0,
      columnNames: result.columnNames,
      rawRows: result.rawRows.map((row) => (Array.isArray(row) ? row.map(toNativeCell) : row))
    };
  }
  const rows =
    result?.array ??
    result?.rows?._array ??
    (Array.isArray(result?.rows) ? result.rows : []) ??
    [];
  const columnNames = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];
  const rawRows = columnNames.length
    ? rows.map((row) => columnNames.map((name) => toNativeCell(row[name])))
    : [];
  return {
    ok: true,
    insertId: result?.insertId ?? 0,
    rowsAffected: result?.rowsAffected ?? 0,
    columnNames,
    rawRows
  };
}

async function loadWebModule(loadWeb) {
  const web = await loadWeb();
  if (!web?.WASQLiteOpenFactory) {
    throw new Error('@powersync/web WASQLiteOpenFactory is required');
  }
  return web;
}

async function openFile(fileKeyValue, dbFilename, dbLocation, attachOptions, loadWeb) {
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
  entry.pending = (async () => {
    const web = await loadWebModule(loadWeb);
    const logger =
      typeof web.createConsoleLogger === 'function'
        ? web.createConsoleLogger({ prefix: 'powersync-lynx' })
        : { log() {} };
    const open = {
      dbFilename,
      ...pickAttachOpenFields(attachOptions)
    };
    if (dbLocation != null && dbLocation !== '') {
      open.dbLocation = dbLocation;
    }
    // Official @powersync/web@2.3 constructor is { open, logger }.
    const factory = new web.WASQLiteOpenFactory({ open, logger });
    let adapter = factory.openDB();
    if (adapter && typeof adapter.then === 'function') {
      adapter = await adapter;
    }
    entry.adapter = adapter;
  })();

  try {
    await entry.pending;
  } catch (err) {
    files.delete(fileKeyValue);
    throw err;
  } finally {
    if (entry) {
      entry.pending = null;
    }
  }

  if (!entry.adapter) {
    files.delete(fileKeyValue);
    throw new Error(`WASQLite open failed for ${dbFilename}`);
  }
  entry.refCount += 1;
  return entry;
}

async function dispatchOpen(data, attachOptions, loadWeb) {
  const dbFilename = data?.dbFilename;
  if (typeof dbFilename !== 'string' || dbFilename.length === 0) {
    return { ok: false, message: 'open requires dbFilename' };
  }
  const dbLocation = data.dbLocation;
  const key = fileKey(dbFilename, dbLocation);
  await openFile(key, dbFilename, dbLocation, attachOptions, loadWeb);
  const dbId = `ps-${++nextDbId}`;
  connections.set(dbId, { fileKey: key, readOnly: !!data.readOnly });
  return { ok: true, dbId };
}

async function dispatchClose(data) {
  const dbId = typeof data === 'string' ? data : data?.dbId;
  if (typeof dbId !== 'string' || !connections.has(dbId)) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const { fileKey: key } = connections.get(dbId);
  connections.delete(dbId);
  const entry = files.get(key);
  if (entry) {
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      files.delete(key);
      await entry.adapter?.close?.();
    }
  }
  return { ok: true };
}

async function withLock(adapter, readOnly, fn) {
  if (readOnly) {
    return adapter.readLock(fn);
  }
  return adapter.writeLock(fn);
}

async function dispatchExecute(data) {
  const dbId = data?.dbId;
  const conn = connections.get(dbId);
  if (!conn) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const entry = files.get(conn.fileKey);
  if (!entry?.adapter) {
    return { ok: false, message: `closed dbId: ${dbId}` };
  }
  const sql = data.sql;
  const params = toSqliteParams(data.params ?? []);
  const result = await withLock(entry.adapter, conn.readOnly, (tx) => tx.executeRaw(sql, params));
  return toNativeEnvelope(result);
}

async function dispatchExecuteBatch(data) {
  const dbId = data?.dbId;
  const conn = connections.get(dbId);
  if (!conn) {
    return { ok: false, message: `unknown dbId: ${dbId}` };
  }
  const entry = files.get(conn.fileKey);
  if (!entry?.adapter) {
    return { ok: false, message: `closed dbId: ${dbId}` };
  }
  const sql = data.sql;
  const params = toSqliteParams(data.params ?? []);
  const result = await withLock(entry.adapter, conn.readOnly, (tx) =>
    conn.readOnly ? tx.executeRaw(sql, params) : tx.executeBatch(sql, params)
  );
  return toNativeEnvelope(result);
}

export async function handleNativeCall(name, encodedData, attachOptions, loadWeb) {
  const data = decodeCloneable(encodedData);
  try {
    let result;
    switch (name) {
      case 'open':
        result = await dispatchOpen(data, attachOptions, loadWeb);
        break;
      case 'close':
        result = await dispatchClose(data);
        break;
      case 'execute':
        result = await dispatchExecute(data);
        break;
      case 'executeBatch':
        result = await dispatchExecuteBatch(data);
        break;
      default:
        result = { ok: false, message: `unknown method: ${name}` };
    }
    return encodeCloneable(result);
  } catch (err) {
    return encodeCloneable(failure(err));
  }
}

export function createOnNativeModulesCall(previous, attachOptions, loadWeb) {
  return async function onNativeModulesCall(name, data, moduleName) {
    if (moduleName !== MODULE_NAME) {
      return previous?.(name, data, moduleName);
    }
    return handleNativeCall(name, data, attachOptions, loadWeb);
  };
}
