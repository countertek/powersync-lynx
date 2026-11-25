import { getLynxHost } from "../../host.ts";
import type { LynxTextCodecHelper } from "../../globals.ts";
import { isNonNullObject, isNumber, isString } from "../../type-guards.ts";
import { copyToArrayBuffer } from "../../values.ts";
import { isGzip } from "../gunzip.ts";

export function toArrayBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return copyToArrayBuffer(bytes);
}

export function trailingIncompleteUtf8Bytes(bytes: Uint8Array): number {
  if (bytes.length === 0) {
    return 0;
  }
  let i = bytes.length - 1;
  let continuation = 0;
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80) {
    continuation++;
    i--;
  }
  if (i < 0) {
    return bytes.length;
  }
  const lead = bytes[i];
  let expected = 0;
  if ((lead & 0x80) === 0) {
    expected = 0;
  } else if ((lead & 0xe0) === 0xc0) {
    expected = 1;
  } else if ((lead & 0xf0) === 0xe0) {
    expected = 2;
  } else if ((lead & 0xf8) === 0xf0) {
    expected = 3;
  } else {
    return 0;
  }
  const have = continuation;
  if (have < expected) {
    return have + 1;
  }
  return 0;
}

function textCodecHelper(): LynxTextCodecHelper | undefined {
  return getLynxHost().textCodec();
}

function decodeUtf8Manual(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < u8.length; i++) {
    binary += String.fromCharCode(u8[i]!);
  }
  try {
    return decodeURIComponent(escape(binary));
  } catch {
    return binary;
  }
}

export function decodeUtf8(bytes: ArrayBuffer): string {
  const helper = textCodecHelper();
  if (helper != null) {
    return helper.decode(bytes);
  }
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  return decodeUtf8Manual(bytes);
}

export function encodeUtf8(text: string): ArrayBuffer {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).buffer;
  }
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    bytes[i] = encoded.charCodeAt(i);
  }
  return copyToArrayBuffer(bytes);
}

export function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** PrimJS / host body shapes coerced to bytes at adapter boundaries. */
export interface HostByteBag {
  readonly buffer?: ArrayBuffer | ArrayBufferView;
  readonly byteLength?: number;
  readonly byteOffset?: number;
  readonly length?: number;
  readonly BYTES_PER_ELEMENT?: number;
  readonly data?: ArrayBuffer | ArrayBufferView | string | readonly number[];
}

export type HostByteSource =
  | ArrayBuffer
  | ArrayBufferView
  | string
  | readonly number[]
  | HostByteBag
  | null
  | undefined;

interface IndexedHostBytes extends HostByteBag {
  readonly [index: number]: number;
}

/**
 * Coerce PrimJS / native wire bodies to bytes. Hosts may hand ArrayBuffers from
 * another realm, number arrays, or latin1 strings of gzip magic.
 */
export function toUint8(data: HostByteSource): Uint8Array {
  if (data == null) {
    return new Uint8Array(0);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  if (isString(data)) {
    const raw = latin1Bytes(data);
    if (isGzip(raw)) {
      return raw;
    }
    return new Uint8Array(encodeUtf8(data));
  }
  if (!isNonNullObject(data)) {
    return new Uint8Array(0);
  }
  const tag = Object.prototype.toString.call(data);
  // PrimJS may hand ArrayBuffers from another realm — instanceof fails.
  if (tag === "[object ArrayBuffer]") {
    try {
      // SAFETY: toString tag is ArrayBuffer when instanceof failed across realms.
      return new Uint8Array(data as ArrayBuffer);
    } catch {
      // fall through
    }
  }
  if (tag === "[object Uint8Array]" || tag === "[object Uint8ClampedArray]") {
    try {
      // SAFETY: toString tag is a typed array when instanceof failed across realms.
      const view = data as ArrayBufferView;
      const copy = new Uint8Array(view.byteLength);
      copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return copy;
    } catch {
      // fall through
    }
  }
  // SAFETY: remaining host values after ArrayBuffer / string / array branches are HostByteBag.
  const rec = data as HostByteBag;
  if (rec.buffer != null && isNumber(rec.byteLength)) {
    try {
      const offset = isNumber(rec.byteOffset) ? rec.byteOffset : 0;
      const length = Number(rec.byteLength);
      const base = toUint8(rec.buffer);
      if (base.byteLength > 0) {
        return base.subarray(offset, offset + length);
      }
    } catch {
      // fall through
    }
  }
  if (isNumber(rec.byteLength) && rec.byteLength > 0 && rec.BYTES_PER_ELEMENT == null) {
    try {
      // SAFETY: host bag with byteLength and no BYTES_PER_ELEMENT is a raw ArrayBuffer.
      return new Uint8Array(data as ArrayBuffer);
    } catch {
      // fall through
    }
  }
  if (isNumber(rec.length) && rec.length > 0) {
    const len = Number(rec.length);
    const out = new Uint8Array(len);
    let numeric = true;
    // SAFETY: PrimJS may hand array-like host objects with numeric keys.
    const indexed = rec as IndexedHostBytes;
    for (let i = 0; i < len; i++) {
      const value = indexed[i];
      if (!isNumber(value)) {
        numeric = false;
        break;
      }
      out[i] = value & 0xff;
    }
    if (numeric) {
      return out;
    }
  }
  if (rec.data != null && rec.data !== data) {
    const nested = toUint8(rec.data);
    if (nested.byteLength > 0) {
      return nested;
    }
  }
  return new Uint8Array(0);
}
