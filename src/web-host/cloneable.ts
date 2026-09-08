import { copyToArrayBuffer, hasPrimitiveConstructor, isNumberArray } from "../values.ts";

export const AB_TAG = "__psAb";
export const BIG_TAG = "__psBig";

export interface TaggedArrayBuffer {
  readonly __psAb: true;
  readonly u8: number[];
}

export interface TaggedBigInt {
  readonly __psBig: true;
  readonly v: string;
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

export function asCloneable(
  value: CloneableObject | Cloneable[] | TaggedArrayBuffer | TaggedBigInt,
): Cloneable {
  return value;
}

export function asCloneableObject(value: CloneableObject): CloneableObject {
  return value;
}

export function encodeCloneable(value: Cloneable): Cloneable {
  if (value === null || value === undefined) {
    return value;
  }
  if (hasPrimitiveConstructor(value, BigInt)) {
    return asCloneable({ [BIG_TAG]: true, v: value.toString(10) });
  }
  if (value instanceof ArrayBuffer) {
    return asCloneable({ [AB_TAG]: true, u8: Array.from(new Uint8Array(value)) });
  }
  if (value instanceof Uint8Array) {
    return asCloneable({ [AB_TAG]: true, u8: Array.from(value) });
  }
  if (Array.isArray(value)) {
    return value.map(encodeCloneable);
  }
  if (value instanceof Object) {
    // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
    const source = value as CloneableObject;
    const mutable: { [key: string]: Cloneable } = {};
    for (const key of Object.keys(source)) {
      mutable[key] = encodeCloneable(source[key]);
    }
    return asCloneableObject(mutable);
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
  if (value instanceof Object) {
    // SAFETY: remaining Cloneable objects are JSON-like CloneableObject records.
    const source = value as CloneableObject;
    const taggedAb = source[AB_TAG];
    const u8 = source.u8;
    if (taggedAb === true) {
      if (!Array.isArray(u8) || !isNumberArray(u8)) {
        throw new Error("invalid tagged ArrayBuffer");
      }
      return copyToArrayBuffer(Uint8Array.from(u8));
    }
    const taggedBig = source[BIG_TAG];
    const encoded = source.v;
    if (taggedBig === true) {
      if (!hasPrimitiveConstructor(encoded, String) || encoded.length === 0) {
        throw new Error("invalid tagged bigint");
      }
      try {
        return BigInt(encoded);
      } catch {
        throw new Error("invalid tagged bigint");
      }
    }
    const mutable: { [key: string]: Cloneable } = {};
    for (const key of Object.keys(source)) {
      mutable[key] = decodeCloneable(source[key]);
    }
    return asCloneableObject(mutable);
  }
  return value;
}
