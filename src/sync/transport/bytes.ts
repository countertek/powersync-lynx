import { getLynxHost, type LynxTextCodecHelper } from "../../host.ts";
import { isFunction, isNonNullObject, isNumber, isString } from "../../type-guards.ts";
import { copyToArrayBuffer } from "../../values.ts";
import { isGzip } from "../gunzip.ts";

function toArrayBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return copyToArrayBuffer(bytes);
}

function trailingIncompleteUtf8Bytes(bytes: Uint8Array): number {
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

export function createLynxTextDecoder(): TextDecoder {
  let carry = new Uint8Array(0);
  const decoder = {
    decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
      const stream = options?.stream === true;
      const incoming = input == null ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(input));
      const combined = new Uint8Array(carry.length + incoming.length);
      combined.set(carry, 0);
      combined.set(incoming, carry.length);
      const hold = stream ? trailingIncompleteUtf8Bytes(combined) : 0;
      const complete = combined.subarray(0, combined.length - hold);
      carry = combined.subarray(combined.length - hold);
      if (complete.length === 0) {
        return "";
      }
      return decodeUtf8(copyToArrayBuffer(complete));
    },
  };
  // SAFETY: Lynx TextCodecHelper.decode is the UTF-8 path; PowerSync only calls decode().
  return decoder as TextDecoder;
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

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface BufferGlobal {
  Buffer?: {
    from(value: string, encoding: string): Uint8Array;
  };
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (typeof atob !== "undefined" && isFunction(atob)) {
    return latin1Bytes(atob(text));
  }
  // SAFETY: Node test runtime may expose Buffer on globalThis.
  const Buf = (globalThis as BufferGlobal).Buffer;
  if (Buf != null) {
    return new Uint8Array(Buf.from(text, "base64"));
  }
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[i]!);
    const b = BASE64_ALPHABET.indexOf(clean[i + 1] ?? "A");
    const cChar = clean[i + 2];
    const dChar = clean[i + 3];
    const c = cChar == null ? 0 : BASE64_ALPHABET.indexOf(cChar);
    const d = dChar == null ? 0 : BASE64_ALPHABET.indexOf(dChar);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[outIndex++] = (n >> 16) & 0xff;
    if (cChar != null) {
      out[outIndex++] = (n >> 8) & 0xff;
    }
    if (dChar != null) {
      out[outIndex++] = n & 0xff;
    }
  }
  return out.subarray(0, outIndex);
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
