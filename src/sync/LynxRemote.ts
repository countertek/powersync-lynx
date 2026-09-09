import "../abort-controller.ts";
import { AbstractRemote } from "@powersync/shared-internals";
import type { PowerSyncBackendConnector, PowerSyncLogger } from "@powersync/common";
import type { FetchOptions } from "@powersync/shared-internals";
import type {
  WebSocketSupport,
  WebSocketSyncStreamPlatform,
} from "@powersync/shared-internals/websockets";
import { copyToArrayBuffer } from "../values.ts";
import { gunzipSync, isGzip } from "./gunzip.ts";

let websockets: WebSocketSupport | undefined;

/**
 * ONE-SHOT diagnostic for the first `/sync/stream` only (FM-PS-LYNX-003).
 * Removable: delete this block and all `firstSyncStream*` call sites.
 */
const FM_PS_LYNX_003 = "[FM-PS-LYNX-003]";
let firstSyncStreamLogged = false;
let firstSyncStreamDiag: {
  t0: number;
  onDataCount: number;
  onDataFirstMs: number | null;
} | null = null;

function beginFirstSyncStreamDiag(url: string, streamingFlags: Record<string, boolean>): void {
  if (firstSyncStreamLogged || !url.includes("/sync/stream")) {
    return;
  }
  firstSyncStreamLogged = true;
  firstSyncStreamDiag = { t0: Date.now(), onDataCount: 0, onDataFirstMs: null };
  console.log(FM_PS_LYNX_003, "first /sync/stream — streaming flags on native request", {
    url,
    streamingFlags,
    useStreaming: streamingFlags.useStreaming === true,
    enableFetchAPIStandardStreaming: streamingFlags.enableFetchAPIStandardStreaming === true,
  });
}

function logFirstSyncStreamPath(
  path: "chunked" | "raw",
  streamingId: string | undefined,
  via: "streamingId" | "fallback" | "raw-body" | "identifier-body",
): void {
  if (firstSyncStreamDiag == null) {
    return;
  }
  console.log(FM_PS_LYNX_003, "native/js stream path", {
    path,
    via,
    streamingId: streamingId ?? null,
  });
}

function noteFirstSyncStreamEvent(event: "onData" | "onEnd" | "onError"): void {
  const diag = firstSyncStreamDiag;
  if (diag == null) {
    return;
  }
  const elapsedMs = Date.now() - diag.t0;
  if (event === "onData") {
    diag.onDataCount += 1;
    if (diag.onDataFirstMs == null) {
      diag.onDataFirstMs = elapsedMs;
      console.log(FM_PS_LYNX_003, "first onData", {
        onDataCount: diag.onDataCount,
        elapsedMs,
      });
    }
    return;
  }
  console.log(FM_PS_LYNX_003, "stream terminal — onData before onEnd?", {
    terminalEvent: event,
    onDataCount: diag.onDataCount,
    onDataFiredBeforeOnEnd: diag.onDataCount > 0,
    onDataFirstMs: diag.onDataFirstMs,
    terminalElapsedMs: elapsedMs,
  });
  firstSyncStreamDiag = null;
}

function finishFirstSyncStreamRaw(bodyByteLength: number): void {
  if (firstSyncStreamDiag == null) {
    return;
  }
  console.log(FM_PS_LYNX_003, "stream terminal — onData before onEnd?", {
    terminalEvent: "raw-body",
    onDataCount: 0,
    onDataFiredBeforeOnEnd: false,
    bodyByteLength,
    note: "raw path: fetch resolved with body bytes; native onData/onEnd not used",
  });
  firstSyncStreamDiag = null;
}

export interface LynxTextCodecHelper {
  decode(buffer: ArrayBuffer): string;
}

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

function textCodecHelper(): LynxTextCodecHelper | undefined {
  const fromGlobalThis = (globalThis as unknown as { TextCodecHelper?: LynxTextCodecHelper })
    .TextCodecHelper;
  if (fromGlobalThis != null) {
    return fromGlobalThis;
  }
  try {
    return (0, eval)(
      "typeof TextCodecHelper === 'undefined' ? undefined : TextCodecHelper",
    ) as LynxTextCodecHelper | undefined;
  } catch {
    return undefined;
  }
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

function decodeUtf8(bytes: ArrayBuffer): string {
  const helper = textCodecHelper();
  if (helper != null) {
    return helper.decode(bytes);
  }
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  return decodeUtf8Manual(bytes);
}

function createLynxTextDecoder(): TextDecoder {
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


interface LynxFetchSuccess {
  url?: string;
  body?: ArrayBuffer | Uint8Array | string | unknown;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
  lynxExtension?: {
    streamingId?: string;
    enableFetchAPIStandardStreaming?: boolean;
    powersyncIdleComplete?: boolean;
    powersyncIdleBodyBase64?: string;
  };
}

interface LynxFetchModule {
  fetch(
    request: Record<string, unknown>,
    resolve: (response: LynxFetchSuccess) => void,
    reject: (error: { message?: string }) => void,
  ): void;
}

/** NativePowerSyncModule.httpFetch envelope — strings only (PrimJS-safe). */
interface NativeHttpFetchEnvelope {
  ok?: boolean;
  message?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  bodyBase64?: string;
  idleComplete?: boolean;
}

interface NativeHttpFetchModule {
  httpFetch?(request: Record<string, unknown>, callback: (envelope: NativeHttpFetchEnvelope) => void): void;
}

/**
 * Resolve NativePowerSyncModule for httpFetch.
 * PrimJS host methods often fail `typeof x === "function"` — never gate on that
 * (LynxFetchModule lookup likewise only checks module presence).
 */
function lookupNativePowerSyncModule(): unknown {
  const fromGlobalThis = (
    globalThis as unknown as { NativeModules?: { NativePowerSyncModule?: unknown } }
  ).NativeModules?.NativePowerSyncModule;
  if (fromGlobalThis != null) {
    return fromGlobalThis;
  }
  try {
    const fromBinding = (
      NativeModules as { NativePowerSyncModule?: unknown } | undefined
    )?.NativePowerSyncModule;
    if (fromBinding != null) {
      return fromBinding;
    }
  } catch {
    // NativeModules may be an unbound identifier outside Lynx.
  }
  try {
    return (0, eval)(
      "typeof NativeModules === 'undefined' ? undefined : NativeModules.NativePowerSyncModule",
    );
  } catch {
    return undefined;
  }
}

function nativeHttpFetchModule(): NativeHttpFetchModule | undefined {
  const mod = lookupNativePowerSyncModule();
  if (mod == null || (typeof mod !== "object" && typeof mod !== "function")) {
    return undefined;
  }
  // Presence only — do not require typeof httpFetch === "function".
  return mod as NativeHttpFetchModule;
}

function describeHttpFetchGate(): {
  hasModule: boolean;
  hasHttpFetch: boolean;
  httpFetchTypeof: string;
} {
  const mod = lookupNativePowerSyncModule();
  if (mod == null || (typeof mod !== "object" && typeof mod !== "function")) {
    return { hasModule: false, hasHttpFetch: false, httpFetchTypeof: "undefined" };
  }
  const httpFetch = (mod as NativeHttpFetchModule).httpFetch;
  return {
    hasModule: true,
    hasHttpFetch: httpFetch != null,
    httpFetchTypeof: typeof httpFetch,
  };
}

function encodeUtf8(text: string): ArrayBuffer {
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

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function toUint8(data: unknown): Uint8Array {
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
  if (typeof data === "string") {
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
    if (rec.buffer != null && typeof rec.byteLength === "number") {
      try {
        const offset = typeof rec.byteOffset === "number" ? rec.byteOffset : 0;
        const length = Number(rec.byteLength);
        const base = toUint8(rec.buffer);
        if (base.byteLength > 0) {
          return base.subarray(offset, offset + length);
        }
      } catch {
        // fall through
      }
    }
    if (typeof rec.byteLength === "number" && rec.byteLength > 0 && rec.BYTES_PER_ELEMENT == null) {
      try {
        return new Uint8Array(data as ArrayBuffer);
      } catch {
        // fall through
      }
    }
    if (typeof rec.length === "number" && rec.length > 0) {
      const len = Number(rec.length);
      const out = new Uint8Array(len);
      let numeric = true;
      for (let i = 0; i < len; i++) {
        const value = (data as Record<string, unknown>)[String(i)];
        if (typeof value !== "number") {
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

function decodeBase64(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (typeof atob === "function") {
    return latin1Bytes(atob(text));
  }
  const Buf = (globalThis as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } }).Buffer;
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

/** Prefer direct body bytes; fall back to ShowcaseLynxHttpService idle-complete base64. */
function bodyFromFetchSuccess(result: LynxFetchSuccess): Uint8Array {
  const direct = toUint8(result.body);
  if (direct.byteLength > 0) {
    return direct;
  }
  const b64 = result.lynxExtension?.powersyncIdleBodyBase64;
  if (typeof b64 === "string" && b64.length > 0) {
    return decodeBase64(b64);
  }
  return direct;
}

function parseJsonText(text: string): unknown {
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

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
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

/**
 * AbstractRemote prefers BSON (`q=0.9`). Lynx often drops Content-Type, so
 * fetchStreamRaw treats the body as NDJSON and splits BSON on 0x0A — rust
 * then raises errorStreamingMalformedResponse. Request NDJSON only.
 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

function preferNdjsonAccept(headers: Record<string, string>): Record<string, string> {
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

function copyHeaderRecord(headers: unknown): Record<string, string> {
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

function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function isParsedJsonValue(value: unknown): boolean {
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

class LynxFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> };
  private rawBody: unknown;
  constructor(result: LynxFetchSuccess, streamingFallback = false) {
    const status = Number(result.status ?? 0);
    const streamingId = result.lynxExtension?.streamingId;
    const idleComplete = result.lynxExtension?.powersyncIdleComplete === true;
    const bodyBytes = bodyFromFetchSuccess(result);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    if (streamingId != null && streamingId.length > 0 && bodyBytes.byteLength === 0 && !idleComplete) {
      logFirstSyncStreamPath("chunked", streamingId, "streamingId");
      reader = streamingReader(streamingId);
    } else if (bodyBytes.byteLength > 0) {
      // Idle-complete / buffered body wins over nameless GlobalEventEmitter fallback.
      // Native may return ~19KB while JS sees streamingId:null — applying raw bytes is required
      // for ps_buckets > 0.
      logFirstSyncStreamPath("raw", streamingId, "raw-body");
      finishFirstSyncStreamRaw(bodyBytes.byteLength);
      reader = readerFromChunks([bodyBytes]);
    } else if (streamingFallback) {
      logFirstSyncStreamPath("chunked", undefined, "fallback");
      reader = streamingReaderFallback();
    } else {
      logFirstSyncStreamPath("raw", undefined, "raw-body");
      finishFirstSyncStreamRaw(0);
      reader = readerFromChunks([]);
    }
    this.rawBody = bodyBytes.byteLength > 0 ? bodyBytes : result.body;
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.statusText = String(result.statusText ?? "");
    const headerMap = copyHeaderRecord(result.headers);
    this.headers = {
      get: (name: string) => headerMap[String(name).toLowerCase()] ?? null,
    };
    this.body = {
      getReader: () => reader,
    };
  }
  async text(): Promise<string> {
    const parts: Uint8Array[] = [];
    const reader = this.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (next.value != null) {
        parts.push(next.value);
      }
    }
    let total = 0;
    for (const part of parts) {
      total += part.byteLength;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    const decoded = isGzip(joined) ? gunzipSync(joined) : joined;
    return decodeUtf8(copyToArrayBuffer(decoded));
  }
  async json(): Promise<unknown> {
    if (isParsedJsonValue(this.rawBody)) {
      return this.rawBody;
    }
    if (typeof this.rawBody === "string") {
      return parseJsonText(this.rawBody);
    }
    return parseJsonText(await this.text());
  }
}

function readerFromChunks(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read() {
      if (i < chunks.length) {
        const value = chunks[i]!;
        i += 1;
        return Promise.resolve({ done: false, value });
      }
      return Promise.resolve({ done: true, value: undefined });
    },
    cancel() {
      i = chunks.length;
      return Promise.resolve();
    },
    releaseLock() {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

interface StreamEmitter {
  addListener(name: string, fn: (payload: unknown) => void): void;
  emit?(name: string, data?: unknown): void;
  trigger?(name: string, params?: unknown): void;
}

const earlyEvents = new Map<string, unknown[]>();
const liveStreamNames = new Set<string>();
const hookedEmitters = new WeakSet<object>();
const hookedLynxHosts = new WeakSet<object>();
const streamHandlers = new WeakMap<object, Map<string, (payload: unknown) => void>>();
const origAdds = new WeakMap<object, StreamEmitter["addListener"]>();
const slottedNames = new WeakMap<object, Set<string>>();
const foreignListeners = new WeakMap<object, Map<string, Array<(payload: unknown) => void>>>();
const hookedEventMaps = new WeakSet<object>();

/** Native LynxFetchModule names streams `LynxFetchModuleStreamingEvent` + AtomicLong. */
const NATIVE_STREAM_PREFIX = "LynxFetchModuleStreamingEvent";
const NATIVE_STREAM_SLOTS = 64;

function unwrapStreamPayload(payload: unknown): unknown {
  if (!Array.isArray(payload)) {
    return payload;
  }
  for (const item of payload) {
    if (item != null && typeof item === "object" && !Array.isArray(item) && "event" in item) {
      return item;
    }
  }
  return payload.length > 0 ? payload[0] : payload;
}

function isStreamEvent(payload: unknown): boolean {
  const eventPayload = unwrapStreamPayload(payload);
  if (eventPayload == null || typeof eventPayload !== "object") {
    return false;
  }
  const event = (eventPayload as { event?: unknown }).event;
  return event === "onData" || event === "onEnd" || event === "onError";
}

function rememberEarly(name: string, payload: unknown): void {
  if (liveStreamNames.has(name) || !isStreamEvent(payload)) {
    return;
  }
  const pending = earlyEvents.get(name);
  if (pending == null) {
    earlyEvents.set(name, [payload]);
    return;
  }
  pending.push(payload);
}

function drainEarly(name: string, deliver: (payload: unknown) => void): void {
  const pending = earlyEvents.get(name);
  earlyEvents.delete(name);
  if (pending == null) {
    return;
  }
  for (const payload of pending) {
    deliver(payload);
  }
}

function slotListener(emitter: object, name: string): (payload: unknown) => void {
  return (payload: unknown) => {
    const handler = streamHandlers.get(emitter)?.get(name);
    if (handler != null) {
      handler(payload);
    } else {
      rememberEarly(name, payload);
    }
    const extras = foreignListeners.get(emitter)?.get(name);
    if (extras != null) {
      for (const fn of extras) {
        fn(payload);
      }
    }
  };
}

function ensureSlot(emitter: StreamEmitter, name: string): void {
  let names = slottedNames.get(emitter);
  if (names == null) {
    names = new Set();
    slottedNames.set(emitter, names);
  }
  if (names.has(name)) {
    return;
  }
  const origAdd = origAdds.get(emitter);
  if (origAdd == null) {
    return;
  }
  names.add(name);
  origAdd(name, slotListener(emitter, name));
}

function preSlotNativeStreams(emitter: StreamEmitter): void {
  for (let i = 0; i < NATIVE_STREAM_SLOTS; i++) {
    ensureSlot(emitter, `${NATIVE_STREAM_PREFIX}${i}`);
  }
}

function lynxHost(): { getJSModule?: (name: string) => StreamEmitter } | undefined {
  try {
    // Bare `lynx` so the Lynx bundler keeps the runtime global (eval/globalThis miss it).
    return lynx as { getJSModule?: (name: string) => StreamEmitter };
  } catch {
    return (
      globalThis as unknown as {
        lynx?: { getJSModule?: (name: string) => StreamEmitter };
      }
    ).lynx;
  }
}

function lookupEmitters(): StreamEmitter[] {
  const host = lynxHost() as
    | {
        getJSModule?: (name: string) => StreamEmitter;
        getApp?: () => { GlobalEventEmitter?: StreamEmitter };
        GlobalEventEmitter?: StreamEmitter;
      }
    | undefined;
  const found: StreamEmitter[] = [];
  const add = (emitter: StreamEmitter | undefined): void => {
    if (emitter != null && !found.includes(emitter)) {
      found.push(emitter);
    }
  };
  // Native sendGlobalEvent posts to the JS module; Lynx fetch may use getApp().
  add(host?.getJSModule?.("GlobalEventEmitter"));
  add(host?.getApp?.()?.GlobalEventEmitter);
  add(host?.GlobalEventEmitter);
  return found;
}

function lookupEmitter(): StreamEmitter | undefined {
  return lookupEmitters()[0];
}

function hookEventsMap(emitter: StreamEmitter): void {
  const events = (emitter as { _events?: Map<string, unknown> })._events;
  if (events == null || typeof events.get !== "function" || hookedEventMaps.has(events)) {
    return;
  }
  hookedEventMaps.add(events);
  const origGet = events.get.bind(events);
  events.get = (name: string) => {
    let list = origGet(name);
    if (list == null || (Array.isArray(list) && list.length === 0)) {
      ensureSlot(emitter, String(name));
      list = origGet(name);
    }
    return list;
  };
}

function hookEmitter(emitter: StreamEmitter): void {
  if (hookedEmitters.has(emitter)) {
    hookEventsMap(emitter);
    return;
  }
  hookedEmitters.add(emitter);
  const origAdd = emitter.addListener.bind(emitter);
  origAdds.set(emitter, origAdd);
  const origEmit = typeof emitter.emit === "function" ? emitter.emit.bind(emitter) : undefined;
  const origTrigger = typeof emitter.trigger === "function" ? emitter.trigger.bind(emitter) : undefined;
  emitter.addListener = (name, fn) => {
    let byName = foreignListeners.get(emitter);
    if (byName == null) {
      byName = new Map();
      foreignListeners.set(emitter, byName);
    }
    let list = byName.get(name);
    if (list == null) {
      list = [];
      byName.set(name, list);
    }
    list.push(fn);
    ensureSlot(emitter, name);
  };
  emitter.emit = (name, data) => {
    rememberEarly(name, data);
    return origEmit?.(name, data);
  };
  emitter.trigger = (name, params) => {
    rememberEarly(name, params);
    return origTrigger?.(name, params);
  };
  preSlotNativeStreams(emitter);
  hookEventsMap(emitter);
}

function wrapLynxGetJSModule(): void {
  const host = lynxHost();
  if (host == null || typeof host.getJSModule !== "function" || hookedLynxHosts.has(host)) {
    return;
  }
  hookedLynxHosts.add(host);
  const orig = host.getJSModule.bind(host);
  host.getJSModule = (name: string) => {
    const mod = orig(name);
    if (name === "GlobalEventEmitter" && mod != null && typeof mod === "object") {
      hookEmitter(mod);
    }
    return mod;
  };
}

function enterEarlyCapture(): void {
  wrapLynxGetJSModule();
  for (const emitter of lookupEmitters()) {
    hookEmitter(emitter);
  }
}

function attachStreamHandler(
  emitter: StreamEmitter,
  eventName: string,
  onEvent: (payload: unknown) => void,
): void {
  let handlers = streamHandlers.get(emitter);
  if (handlers == null) {
    handlers = new Map();
    streamHandlers.set(emitter, handlers);
  }
  handlers.set(eventName, onEvent);
  ensureSlot(emitter, eventName);
  drainEarly(eventName, onEvent);
}

function nativeStreamNames(): string[] {
  const names: string[] = [];
  for (let i = 0; i < NATIVE_STREAM_SLOTS; i++) {
    names.push(`${NATIVE_STREAM_PREFIX}${i}`);
  }
  return names;
}

function createStreamingReader(eventNames: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const queue: Uint8Array[] = [];
  let finished = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  wrapLynxGetJSModule();
  const emitters = lookupEmitters();
  if (emitters.length === 0) {
    throw new Error("GlobalEventEmitter is not registered");
  }
  const onEvent = (payload: unknown) => {
    const eventPayload = unwrapStreamPayload(payload);
    const event =
      eventPayload != null && typeof eventPayload === "object" && "event" in eventPayload
        ? String((eventPayload as { event?: unknown }).event)
        : "";
    const data =
      eventPayload != null && typeof eventPayload === "object" && "data" in eventPayload
        ? (eventPayload as { data?: unknown }).data
        : undefined;
    const error =
      eventPayload != null && typeof eventPayload === "object" && "error" in eventPayload
        ? (eventPayload as { error?: unknown }).error
        : undefined;
    if (event === "onData") {
      noteFirstSyncStreamEvent("onData");
      queue.push(toUint8(data));
    } else if (event === "onEnd") {
      noteFirstSyncStreamEvent("onEnd");
      finished = true;
    } else if (event === "onError") {
      noteFirstSyncStreamEvent("onError");
      failure = new Error(error == null ? "Lynx HTTP stream error" : String(error));
      finished = true;
    }
    wake?.();
  };
  const attached: Array<{ emitter: StreamEmitter; eventName: string }> = [];
  for (const emitter of emitters) {
    hookEmitter(emitter);
    for (const eventName of eventNames) {
      attachStreamHandler(emitter, eventName, onEvent);
      attached.push({ emitter, eventName });
    }
  }
  return {
    async read() {
      for (;;) {
        if (failure != null) {
          throw failure;
        }
        if (queue.length > 0) {
          return { done: false, value: queue.shift()! };
        }
        if (finished) {
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    cancel() {
      finished = true;
      for (const item of attached) {
        streamHandlers.get(item.emitter)?.delete(item.eventName);
      }
      wake?.();
      return Promise.resolve();
    },
    releaseLock() {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

function streamingReader(eventName: string): ReadableStreamDefaultReader<Uint8Array> {
  return createStreamingReader([eventName]);
}

/** Native streaming always posts to LynxFetchModuleStreamingEventN and resolves an empty body. */
function streamingReaderFallback(): ReadableStreamDefaultReader<Uint8Array> {
  return createStreamingReader(nativeStreamNames());
}

function unwrapFetchSuccess(result: unknown): LynxFetchSuccess {
  if (Array.isArray(result) && result.length > 0 && result[0] != null && typeof result[0] === "object") {
    return result[0] as LynxFetchSuccess;
  }
  return (result ?? {}) as LynxFetchSuccess;
}

function moduleResponse(result: LynxFetchSuccess, streamingFallback = false): Response {
  return new LynxFetchResponse(result, streamingFallback) as unknown as Response;
}

function isLynxAndroid(): boolean {
  try {
    const fromGlobal = (globalThis as unknown as { SystemInfo?: { platform?: string } }).SystemInfo;
    const info =
      fromGlobal ??
      ((0, eval)("typeof SystemInfo === 'undefined' ? undefined : SystemInfo") as { platform?: string } | undefined);
    const platform = info?.platform;
    return platform != null && platform.toLowerCase() === "android";
  } catch {
    return false;
  }
}

function lynxFetchModule(): LynxFetchModule | undefined {
  const fromGlobalThis = (
    globalThis as unknown as { NativeModules?: { LynxFetchModule?: LynxFetchModule } }
  ).NativeModules?.LynxFetchModule;
  if (fromGlobalThis != null) {
    return fromGlobalThis;
  }
  try {
    return (0, eval)(
      "typeof NativeModules === 'undefined' ? undefined : NativeModules.LynxFetchModule",
    ) as LynxFetchModule | undefined;
  } catch {
    return undefined;
  }
}

function streamingExtension(expectStreamingResponse: boolean): Record<string, boolean> {
  if (!expectStreamingResponse) {
    return {};
  }
  // Android showcase: ShowcaseLynxHttpService idle-completes non-streaming /sync/stream and
  // stashes NDJSON as powersyncIdleBodyBase64. Requesting standard streaming here previously
  // yielded streamingId:null + empty body while JS waited on nameless GlobalEventEmitter
  // fallback — ps_buckets stayed 0. Force the buffered handoff on Android.
  if (isLynxAndroid()) {
    return {};
  }
  // Do NOT set useStreaming: that selects Lynx's deprecated CRLF chunked parser, which
  // mis-parses PowerSync NDJSON (LF-only) and yields errorStreamingMalformedResponse.
  return { enableFetchAPIStandardStreaming: true };
}

/**
 * Lynx streaming Response.body is one-shot. AbstractRemote checks `res.body`
 * then calls `res.body.getReader()`; a second getter throws "body used".
 */
function stabilizeStreamingResponse(response: Response, capturedBody?: Response["body"]): Response {
  const captured = capturedBody === undefined ? response.body : capturedBody;
  const headers = response.headers;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: {
      get: (name: string) => (headers == null ? null : headers.get(name)),
    },
    body: captured,
    text: () => response.text(),
    json: () => decodeIdentifierJson(response),
  } as Response;
}

/**
 * JSON GETs must not read Response.body first. Lynx's one-shot body getter
 * consumes the payload; later json()/text() then see undefined.
 */
function stabilizeJsonResponse(response: Response): Response {
  const headers = response.headers;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: {
      get: (name: string) => (headers == null ? null : headers.get(name)),
    },
    text: () => response.text(),
    json: () => decodeIdentifierJson(response),
  } as Response;
}

async function decodeIdentifierJson(response: Response): Promise<unknown> {
  const withJson = response as Response & { json?: () => Promise<unknown> };
  if (typeof withJson.json === "function") {
    try {
      const value = await withJson.json();
      if (isParsedJsonValue(value)) {
        return value;
      }
      if (typeof value === "string") {
        return parseJsonText(value);
      }
    } catch {
      // Lynx json() throws on the string undefined or gzip magic.
    }
  }
  const withText = response as Response & { text?: () => Promise<string> };
  if (typeof withText.text === "function") {
    return parseJsonText(await withText.text());
  }
  return { data: {} };
}

function eventStreamingResponse(response: Response, streamingId?: string): Response {
  const headers = { "content-type": response.headers?.get("content-type") ?? "" };
  if (streamingId != null && streamingId.length > 0) {
    return moduleResponse({
      status: response.status,
      statusText: response.statusText,
      headers,
      lynxExtension: { streamingId },
    });
  }
  if (lookupEmitter() != null) {
    return moduleResponse(
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
      true,
    );
  }
  return stabilizeStreamingResponse(response, {
    getReader: () => readerFromChunks([]),
  } as Response["body"]);
}

async function identifierStreamingResponse(response: Response): Promise<Response> {
  const streamingId = (response as Response & { lynxExtension?: { streamingId?: string } }).lynxExtension
    ?.streamingId;
  let captured: Response["body"];
  try {
    captured = response.body;
  } catch {
    return eventStreamingResponse(response, streamingId);
  }
  if (captured == null || typeof captured.getReader !== "function") {
    return eventStreamingResponse(response, streamingId);
  }
  // Official identifier body is often an empty/non-incremental stub while
  // native onData still arrives on GlobalEventEmitter.
  if (lookupEmitter() != null) {
    return eventStreamingResponse(response, streamingId);
  }
  // Identifier Response.body path (no GlobalEventEmitter) — not native onData chunks.
  logFirstSyncStreamPath("chunked", streamingId, "identifier-body");
  if (firstSyncStreamDiag != null) {
    console.log(FM_PS_LYNX_003, "stream terminal — onData before onEnd?", {
      terminalEvent: "identifier-body",
      onDataCount: 0,
      onDataFiredBeforeOnEnd: false,
      streamingId: streamingId ?? null,
      note: "using Response.body.getReader(); native onData/onEnd not attached",
    });
    firstSyncStreamDiag = null;
  }
  return stabilizeStreamingResponse(response, captured);
}

function fetchViaNativeHttp(resource: string, request: RequestInit): Promise<Response> {
  const native = nativeHttpFetchModule();
  if (native == null) {
    throw new Error("NativePowerSyncModule.httpFetch is not registered");
  }
  const httpFetch = native.httpFetch;
  if (httpFetch == null) {
    throw new Error("NativePowerSyncModule.httpFetch is missing");
  }
  const headers = headerMap(request.headers);
  const payload: Record<string, unknown> = {
    method: String(request.method ?? "GET"),
    url: resource,
    headers,
  };
  if (typeof request.body === "string") {
    // String body crosses the Native Module bridge; ArrayBuffer often does not.
    payload.body = request.body;
  }
  if (firstSyncStreamDiag != null) {
    console.log(FM_PS_LYNX_003, "invoking NativePowerSyncModule.httpFetch", {
      url: resource,
      httpFetchTypeof: typeof httpFetch,
    });
  }
  return new Promise((resolve, reject) => {
    // Direct call like SQL RPC (open/execute). Do not use .call/.apply — PrimJS host
    // methods may not be JS Function objects.
    native.httpFetch!(payload, (envelope: NativeHttpFetchEnvelope) => {
      try {
        const result = unwrapFetchSuccess(envelope) as NativeHttpFetchEnvelope;
        if (result.ok === false) {
          reject(new Error(result.message ?? "NativePowerSyncModule.httpFetch failed"));
          return;
        }
        const status = Number(result.status ?? 0);
        const bodyText = typeof result.body === "string" ? result.body : "";
        const success: LynxFetchSuccess = {
          status,
          statusText: String(result.statusText ?? ""),
          headers: {
            "content-type":
              typeof result.contentType === "string" && result.contentType.length > 0
                ? result.contentType
                : "application/x-ndjson",
          },
          body: bodyText,
          lynxExtension: {
            powersyncIdleComplete: result.idleComplete === true || bodyText.length > 0,
            powersyncIdleBodyBase64:
              typeof result.bodyBase64 === "string" ? result.bodyBase64 : undefined,
          },
        };
        // Complete body in hand — never nameless GlobalEventEmitter fallback.
        resolve(moduleResponse(success, false));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function fetchViaLynxModule(
  resource: string,
  request: RequestInit,
  expectStreamingResponse: boolean,
): Promise<Response> {
  const native = lynxFetchModule();
  if (native == null) {
    throw new Error("LynxFetchModule is not registered");
  }
  const headers = headerMap(request.headers);
  const payload: Record<string, unknown> = {
    method: String(request.method ?? "GET"),
    url: resource,
    headers,
  };
  const extension = streamingExtension(expectStreamingResponse);
  if (Object.keys(extension).length > 0) {
    payload.lynxExtension = extension;
  }
  if (typeof request.body === "string") {
    payload.body = encodeUtf8(request.body);
  }
  return new Promise((resolve, reject) => {
    native.fetch(
      payload,
      (result) => {
        try {
          resolve(moduleResponse(unwrapFetchSuccess(result), expectStreamingResponse));
        } catch (err) {
          reject(err);
        }
      },
      (error) => {
        reject(new Error(error?.message ?? "LynxFetchModule.fetch failed"));
      },
    );
  });
}

export class LynxRemote extends AbstractRemote {
  constructor(connector: PowerSyncBackendConnector, logger: PowerSyncLogger) {
    super(connector, logger);
  }

  createTextDecoder(): TextDecoder {
    return createLynxTextDecoder();
  }

  async fetch({ resource, request, expectStreamingResponse }: FetchOptions): Promise<Response> {
    const url = String(resource);
    const extension = streamingExtension(expectStreamingResponse);
    if (expectStreamingResponse) {
      beginFirstSyncStreamDiag(url, extension);
      enterEarlyCapture();
    }
    // Android: LynxFetchModule drops large byte[] / customInfo for /sync/stream. Use
    // NativePowerSyncModule.httpFetch (UTF-8 string body) for streaming downloads.
    if (isLynxAndroid() && expectStreamingResponse) {
      const nativeHttp = nativeHttpFetchModule();
      if (nativeHttp != null) {
        return fetchViaNativeHttp(url, request);
      }
      console.log(FM_PS_LYNX_003, "httpFetch gate failed — falling back to LynxFetchModule", {
        url,
        ...describeHttpFetchGate(),
        note: "PrimJS host methods must not be gated on typeof === 'function'",
      });
    }
    if (isLynxAndroid() && lynxFetchModule() != null) {
      return fetchViaLynxModule(url, request, expectStreamingResponse);
    }
    const init: RequestInit & { lynxExtension?: Record<string, boolean> } = {
      method: request.method ?? "GET",
      headers: headerMap(request.headers),
    };
    if (typeof request.body === "string") {
      init.body = request.body;
    }
    if (Object.keys(extension).length > 0) {
      init.lynxExtension = extension;
    }
    // PrimJS puts fetch on the identifier, not always on globalThis (iOS).
    const fromGlobal = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    const response = await (typeof fromGlobal === "function" ? fromGlobal : fetch)(url, init);
    if (!expectStreamingResponse) {
      return stabilizeJsonResponse(response);
    }
    return identifierStreamingResponse(response);
  }

  async loadWebSocketSupport(platform: WebSocketSyncStreamPlatform): Promise<WebSocketSupport> {
    if (!websockets) {
      const module = await import("@powersync/shared-internals/websockets");
      websockets = new module.WebSocketSupport(platform);
    }
    return websockets;
  }

  getUserAgent(): string {
    return [super.getUserAgent(), "powersync-lynx"].join(" ");
  }
}
