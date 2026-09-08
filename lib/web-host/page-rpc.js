import { asCloneableObject, decodeCloneable, encodeCloneable, } from "./cloneable.js";
import { copyToArrayBuffer, errorCode, hasPrimitiveConstructor } from "../values.js";
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
];
const files = new Map();
const connections = new Map();
let nextDbId = 0;
export function fileKey(dbFilename, dbLocation) {
    return `${dbFilename}\0${dbLocation ?? ""}`;
}
export function resetWebHostMapping() {
    files.clear();
    connections.clear();
    nextDbId = 0;
}
export function mappingStats() {
    return {
        files: files.size,
        connections: connections.size,
    };
}
function failure(err) {
    const message = err instanceof Error
        ? err.message
        : err instanceof Object && err.message != null
            ? String(err.message)
            : String(err);
    const result = { ok: false, message };
    if (err instanceof Object) {
        const code = errorCode(err);
        if (code !== undefined)
            result.code = code;
    }
    return result;
}
function pickAttachOpenFields(attachOptions) {
    const open = {};
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
function assignAttachOption(open, key, value) {
    switch (key) {
        case "vfs":
            if (hasPrimitiveConstructor(value, String))
                open.vfs = value;
            break;
        case "useWebWorker":
            if (hasPrimitiveConstructor(value, Boolean))
                open.useWebWorker = value;
            break;
        case "enableMultiTabs":
            if (hasPrimitiveConstructor(value, Boolean))
                open.enableMultiTabs = value;
            break;
        case "worker":
            if (value !== undefined &&
                !hasPrimitiveConstructor(value, Boolean) &&
                !hasPrimitiveConstructor(value, Number)) {
                open.worker = value;
            }
            break;
        case "additionalReaders":
            if (hasPrimitiveConstructor(value, Number))
                open.additionalReaders = value;
            break;
        case "temporaryStorage":
            if (hasPrimitiveConstructor(value, String))
                open.temporaryStorage = value;
            break;
        case "cacheSizeKb":
            if (hasPrimitiveConstructor(value, Number))
                open.cacheSizeKb = value;
            break;
        case "databaseWorkerLogLevel":
            if (hasPrimitiveConstructor(value, Number))
                open.databaseWorkerLogLevel = value;
            break;
        case "disableSSRWarning":
            if (hasPrimitiveConstructor(value, Boolean))
                open.disableSSRWarning = value;
            break;
    }
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
        return copyToArrayBuffer(value);
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
            // SAFETY: toNativeCell keeps SQLite cells as NativeCell or ArrayBuffer blobs for the native envelope.
            rawRows: result.rawRows.map((row) => Array.isArray(row) ? row.map(toNativeCell) : row),
        };
    }
    const rowsFromArray = result.array;
    const rowsFromDeprecated = result.rows instanceof Object && !Array.isArray(result.rows) ? result.rows._array : undefined;
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
        rawRows: rawRows,
    };
}
async function loadWebModule(loadWeb) {
    const web = await loadWeb();
    if (web.WASQLiteOpenFactory == null) {
        throw new Error("@powersync/web WASQLiteOpenFactory is required");
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
    const opening = entry;
    opening.pending = (async () => {
        const web = await loadWebModule(loadWeb);
        const logger = web.createConsoleLogger instanceof Function
            ? web.createConsoleLogger({ prefix: "powersync-lynx" })
            : { log() { } };
        const open = {
            dbFilename,
            ...pickAttachOpenFields(attachOptions),
        };
        if (dbLocation != null && dbLocation !== "") {
            open.dbLocation = dbLocation;
        }
        const factory = new web.WASQLiteOpenFactory({ open, logger });
        let adapter = factory.openDB();
        if (adapter instanceof Promise) {
            adapter = await adapter;
        }
        opening.adapter = adapter;
    })();
    try {
        await opening.pending;
    }
    catch (err) {
        files.delete(fileKeyValue);
        throw err;
    }
    finally {
        opening.pending = null;
    }
    if (!opening.adapter) {
        files.delete(fileKeyValue);
        throw new Error(`WASQLite open failed for ${dbFilename}`);
    }
    opening.refCount += 1;
    return opening;
}
function asOpenRequest(data) {
    if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
        // SAFETY: Native Module open/close payloads are JSON-like OpenRequest records.
        return data;
    }
    return {};
}
async function dispatchOpen(data, attachOptions, loadWeb) {
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
async function dispatchClose(data) {
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
async function withLock(adapter, readOnly, fn) {
    if (readOnly) {
        return adapter.readLock(fn);
    }
    return adapter.writeLock(fn);
}
function asExecuteRequest(data) {
    if (data instanceof Object && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
        // SAFETY: Native Module execute payloads are JSON-like ExecuteRequest records.
        return data;
    }
    return {};
}
async function dispatchExecute(data) {
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
async function dispatchExecuteBatch(data) {
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
    const result = await withLock(entry.adapter, conn.readOnly, (tx) => conn.readOnly ? tx.executeRaw(sql, params) : tx.executeBatch(sql, params));
    return toNativeEnvelope(result);
}
function envelopeToCloneable(result) {
    if (result.ok === false) {
        if (result.code === undefined) {
            return { ok: false, message: result.message };
        }
        return { ok: false, message: result.message, code: result.code };
    }
    const rawRows = result.rawRows?.map((row) => row.map((cell) => (cell instanceof Uint8Array ? copyToArrayBuffer(cell) : cell)));
    return {
        ok: true,
        dbId: result.dbId,
        insertId: result.insertId,
        rowsAffected: result.rowsAffected,
        columnNames: result.columnNames,
        rawRows,
    };
}
export async function handleNativeCall(name, encodedData, attachOptions, loadWeb) {
    const data = decodeCloneable(encodedData);
    try {
        let result;
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
    }
    catch (err) {
        if (err instanceof Error) {
            return encodeCloneable(envelopeToCloneable(failure(err)));
        }
        if (err instanceof Object) {
            return encodeCloneable(envelopeToCloneable(failure(err)));
        }
        return encodeCloneable(envelopeToCloneable(failure(String(err))));
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
