import { getLynxHost } from "../../host.ts";
import type { LynxTextCodecHelper } from "../../globals.ts";
import { isNumber, isString } from "../../type-guards.ts";
import { copyToArrayBuffer } from "../../values.ts";
import { gunzipSync, isGzip } from "../gunzip.ts";

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

/**
 * Coerce PrimJS / native wire bodies to bytes. Hosts may hand ArrayBuffers from
 * another realm, number arrays, or latin1 strings of gzip magic.
 */
export function toUint8(data: unknown): Uint8Array {
  if (data == null) {
    return new Uint8Array(0);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data as ArrayBufferView)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data as number[]);
  }
  if (isString(data)) {
    const raw = latin1Bytes(data);
    if (isGzip(raw)) {
      return raw;
    }
    return new Uint8Array(encodeUtf8(data));
  }
  if (typeof data === "object") {
    const tag = Object.prototype.toString.call(data);
    // PrimJS may hand ArrayBuffers from another realm — instanceof fails.
    if (tag === "[object ArrayBuffer]") {
      try {
        return new Uint8Array(data as ArrayBuffer);
      } catch {
        // fall through
      }
    }
    if (tag === "[object Uint8Array]" || tag === "[object Uint8ClampedArray]") {
      try {
        const view = data as ArrayBufferView;
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        return copy;
      } catch {
        // fall through
      }
    }
    const rec = data as {
      buffer?: unknown;
      byteLength?: unknown;
      byteOffset?: unknown;
      length?: unknown;
      BYTES_PER_ELEMENT?: unknown;
      data?: unknown;
    };
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
        return new Uint8Array(data as ArrayBuffer);
      } catch {
        // fall through
      }
    }
    if (isNumber(rec.length) && rec.length > 0) {
      const len = Number(rec.length);
      const out = new Uint8Array(len);
      let numeric = true;
      for (let i = 0; i < len; i++) {
        const value = (data as Record<string, unknown>)[String(i)];
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
  }
  return new Uint8Array(0);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBase64(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (typeof atob === "function") {
    return latin1Bytes(atob(text));
  }
  const Buf = (globalThis as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } })
    .Buffer;
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

export function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

export function isParsedJsonValue(value: unknown): boolean {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return false;
  }
  return true;
}

export function parseJsonText(text: string): unknown {
  const trimmed = stripBom(text).trim();
  if (trimmed.length === 0 || trimmed === "undefined") {
    return { data: {} };
  }
  const raw = latin1Bytes(trimmed);
  if (isGzip(raw)) {
    const inflated = gunzipSync(raw);
    return JSON.parse(stripBom(decodeUtf8(copyToArrayBuffer(inflated))).trim());
  }
  return JSON.parse(trimmed);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

/**
 * AbstractRemote prefers BSON (`q=0.9`). Lynx often drops Content-Type, so
 * fetchStreamRaw treats the body as NDJSON and splits BSON on 0x0A — rust
 * then raises errorStreamingMalformedResponse. Request NDJSON only.
 */
export function preferNdjsonAccept(headers: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept" && headers[key]!.includes("bson-stream")) {
      headers[key] = "application/x-ndjson";
    }
  }
  // OkHttp/Lynx may gzip JSON and hand the compressed bytes to JS.
  if (!hasHeader(headers, "accept-encoding")) {
    headers["Accept-Encoding"] = "identity";
  }
  return headers;
}

export function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers == null || typeof headers !== "object") {
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (pair != null && pair.length >= 2 && pair[0] != null && pair[1] != null) {
        out[String(pair[0])] = String(pair[1]);
      }
    }
    return preferNdjsonAccept(out);
  }
  const rec = headers as Record<string, unknown>;
  for (const key in rec) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) {
      continue;
    }
    const value = rec[key];
    if (value != null) {
      out[key] = String(value);
    }
  }
  return preferNdjsonAccept(out);
}

export function copyHeaderRecord(headers: unknown): Record<string, string> {
  const lower: Record<string, string> = {};
  if (headers == null || typeof headers !== "object") {
    return lower;
  }
  const rec = headers as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (value == null || typeof value === "object") {
      continue;
    }
    lower[key.toLowerCase()] = String(value);
  }
  return lower;
}
