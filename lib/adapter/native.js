import { copyToArrayBuffer, isNumberArray } from "../values.js";
export class NativeModuleError extends Error {
    code;
}
function getNativeModule() {
    const modules = globalThis.NativeModules;
    const native = modules?.NativePowerSyncModule;
    if (native == null) {
        throw new Error("NativePowerSyncModule is not registered");
    }
    return native;
}
function parseNativeEnvelope(envelope) {
    if (envelope == null || envelope.ok === false) {
        const failed = {
            ok: false,
            message: envelope?.message ?? "NativePowerSyncModule request failed",
        };
        if (envelope?.code != null) {
            failed.code = envelope.code;
        }
        return failed;
    }
    const ok = { ok: true };
    if (envelope.dbId !== undefined)
        ok.dbId = envelope.dbId;
    if (envelope.insertId !== undefined)
        ok.insertId = envelope.insertId;
    if (envelope.rowsAffected !== undefined)
        ok.rowsAffected = envelope.rowsAffected;
    if (envelope.columnNames !== undefined)
        ok.columnNames = envelope.columnNames;
    if (envelope.rawRows !== undefined)
        ok.rawRows = envelope.rawRows;
    return ok;
}
function rejectNative(envelope) {
    const error = new NativeModuleError(envelope.message);
    if (envelope.code != null) {
        error.code = envelope.code;
    }
    return error;
}
function withNativeCallback(run) {
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
export function callNative(method, first, sql, params) {
    const native = getNativeModule();
    switch (method) {
        case "open":
            // SAFETY: open overload requires OpenPayload as the first argument.
            return withNativeCallback((callback) => native.open(first, callback));
        case "close":
            // SAFETY: close overload requires dbId string as the first argument.
            return withNativeCallback((callback) => native.close(first, callback));
        case "execute":
            // SAFETY: execute overload is (dbId, sql, BindValues).
            return withNativeCallback((callback) => native.execute(first, sql, params, callback));
        case "executeBatch":
            // SAFETY: executeBatch overload is (dbId, sql, BindValueRows).
            return withNativeCallback((callback) => native.executeBatch(first, sql, params, callback));
    }
}
export function blobToArrayBuffer(value) {
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
export function encodeBindParams(params) {
    if (params == null) {
        return [];
    }
    return params.map(blobToArrayBuffer);
}
export function encodeBindParamRows(params) {
    if (params == null) {
        return [];
    }
    return params.map(encodeBindParams);
}
export function decodeCell(value) {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    return value;
}
export function decodeRawRows(rawRows) {
    return (rawRows ?? []).map((row) => (row ?? []).map(decodeCell));
}
