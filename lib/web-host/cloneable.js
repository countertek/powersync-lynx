import { copyToArrayBuffer, hasPrimitiveConstructor, isNumberArray } from "../values.js";
export const AB_TAG = "__psAb";
export const BIG_TAG = "__psBig";
export function asCloneable(value) {
    return value;
}
export function asCloneableObject(value) {
    return value;
}
export function encodeCloneable(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (hasPrimitiveConstructor(value, BigInt)) {
        return asCloneable({ [BIG_TAG]: true, v: value.toString(10) });
    }
    if (value instanceof ArrayBuffer) {
        return asCloneable({ [AB_TAG]: true, u8: Array.from(new Uint8Array(value)) });
    }
    if (Array.isArray(value)) {
        return value.map(encodeCloneable);
    }
    if (value instanceof Object) {
        // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
        const source = value;
        const mutable = {};
        for (const key of Object.keys(source)) {
            mutable[key] = encodeCloneable(source[key]);
        }
        return asCloneableObject(mutable);
    }
    return value;
}
export function decodeCloneable(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(decodeCloneable);
    }
    if (value instanceof Object) {
        // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
        const source = value;
        const taggedAb = source[AB_TAG];
        const u8 = source.u8;
        if (taggedAb === true && Array.isArray(u8) && isNumberArray(u8)) {
            return copyToArrayBuffer(Uint8Array.from(u8));
        }
        const taggedBig = source[BIG_TAG];
        const encoded = source.v;
        if (taggedBig === true && hasPrimitiveConstructor(encoded, String)) {
            return BigInt(encoded);
        }
        const mutable = {};
        for (const key of Object.keys(source)) {
            mutable[key] = decodeCloneable(source[key]);
        }
        return asCloneableObject(mutable);
    }
    return value;
}
