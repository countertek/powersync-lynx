import { isBigInt, isNonNullObject } from "../type-guards.ts";
import {
  BIG_TAG,
  copyToArrayBuffer,
  decodeTaggedBigInt,
  encodeTaggedBigInt,
  isNumberArray,
  type TaggedBigInt,
} from "../values.ts";

export { BIG_TAG, type TaggedBigInt };

export const AB_TAG = "__psAb";

export interface TaggedArrayBuffer {
  readonly __psAb: true;
  readonly u8: number[];
}

export interface CloneableObject {
  readonly [key: string]: Cloneable | undefined;
}

export type Cloneable =
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | ArrayBuffer
  | Uint8Array
  | Cloneable[]
  | TaggedArrayBuffer
  | TaggedBigInt
  | CloneableObject;

export function encodeCloneable(value: Cloneable): Cloneable {
  if (value === null || value === undefined) {
    return value;
  }
  if (isBigInt(value)) {
    return encodeTaggedBigInt(value);
  }
  if (value instanceof ArrayBuffer) {
    return { [AB_TAG]: true, u8: Array.from(new Uint8Array(value)) };
  }
  if (value instanceof Uint8Array) {
    return { [AB_TAG]: true, u8: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeCloneable);
  }
  if (isNonNullObject(value)) {
    // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
    const source = value as CloneableObject;
    const mutable: { [key: string]: Cloneable } = {};
    for (const key of Object.keys(source)) {
      mutable[key] = encodeCloneable(source[key]);
    }
    return mutable;
  }
  return value;
}

export function decodeCloneable(value: Cloneable): Cloneable {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeCloneable);
  }
  if (isNonNullObject(value)) {
    // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
    const source = value as CloneableObject;
    const taggedAb = source[AB_TAG];
    const u8 = source.u8;
    if (taggedAb === true) {
      if (!isNumberArray(u8)) {
        throw new Error("invalid tagged ArrayBuffer");
      }
      return copyToArrayBuffer(Uint8Array.from(u8));
    }
    const taggedBig = decodeTaggedBigInt(source);
    if (taggedBig !== undefined) {
      return taggedBig;
    }
    const mutable: { [key: string]: Cloneable } = {};
    for (const key of Object.keys(source)) {
      mutable[key] = decodeCloneable(source[key]);
    }
    return mutable;
  }
  return value;
}
