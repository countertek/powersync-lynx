/** Copy bytes into a standalone ArrayBuffer (avoids SharedArrayBuffer from `.slice`). */
export function copyToArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    // SAFETY: a newly allocated Uint8Array is backed by ArrayBuffer, not SharedArrayBuffer.
    return copy.buffer;
}
export function hasPrimitiveConstructor(value, ctor) {
    return (value !== null &&
        value !== undefined &&
        !(value instanceof Object) &&
        value.constructor === ctor);
}
export function isNumberArray(value) {
    return Array.isArray(value) && value.every((item) => hasPrimitiveConstructor(item, Number));
}
export function errorCode(err) {
    if (!("code" in err)) {
        return undefined;
    }
    // SAFETY: Native Module / WASQLite failures expose `code` as a JSON primitive when present.
    const code = err.code;
    return hasPrimitiveConstructor(code, Number) ? code : undefined;
}
