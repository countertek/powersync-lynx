import type { NativeFailEnvelope } from "./adapter/native.ts";
import { isNonNullObject, isNumber, isString } from "./type-guards.ts";

export const BIG_TAG = "__psBig";

export interface TaggedBigInt {
  readonly __psBig: true;
  readonly v: string;
}

/** Copy bytes into a standalone ArrayBuffer (avoids SharedArrayBuffer from `.slice`). */
export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  // SAFETY: a newly allocated Uint8Array is backed by ArrayBuffer, not SharedArrayBuffer.
  return copy.buffer as ArrayBuffer;
}

export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

export function encodeTaggedBigInt(value: bigint): TaggedBigInt {
  return { [BIG_TAG]: true, v: value.toString(10) };
}

export function decodeTaggedBigInt<T>(value: T): bigint | undefined {
  if (
    !isNonNullObject(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  if (!(BIG_TAG in value) || value[BIG_TAG] !== true) {
    return undefined;
  }
  if (!("v" in value) || !isString(value.v) || value.v.length === 0) {
    throw new Error("invalid tagged bigint");
  }
  try {
    return BigInt(value.v);
  } catch {
    throw new Error("invalid tagged bigint");
  }
}

export function failEnvelopeFromError(cause: unknown): NativeFailEnvelope {
  let message: string;
  if (cause instanceof Error) {
    message = cause.message;
  } else if (isNonNullObject(cause) && "message" in cause && cause.message != null) {
    message = String(cause.message);
  } else {
    message = String(cause);
  }
  const envelope: NativeFailEnvelope = { ok: false, message };
  if (isNonNullObject(cause) && "code" in cause && isNumber(cause.code)) {
    envelope.code = cause.code;
  }
  return envelope;
}
