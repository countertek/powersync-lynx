import "../abort-controller.ts";
import { AbstractRemote } from "@powersync/shared-internals";
import type { PowerSyncBackendConnector, PowerSyncLogger } from "@powersync/common";
import type { FetchOptions } from "@powersync/shared-internals";
import type {
  WebSocketSupport,
  WebSocketSyncStreamPlatform,
} from "@powersync/shared-internals/websockets";
import { copyToArrayBuffer } from "../values.ts";

let websockets: WebSocketSupport | undefined;

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
  body?: ArrayBuffer | Uint8Array | string;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
  lynxExtension?: { streamingId?: string; enableFetchAPIStandardStreaming?: boolean };
}

interface LynxFetchModule {
  fetch(
    request: Record<string, unknown>,
    resolve: (response: LynxFetchSuccess) => void,
    reject: (error: { message?: string }) => void,
  ): void;
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

function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data as number[]);
  }
  if (typeof data === "string") {
    return new Uint8Array(encodeUtf8(data));
  }
  return new Uint8Array(0);
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
function preferNdjsonAccept(headers: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept" && headers[key]!.includes("bson-stream")) {
      headers[key] = "application/x-ndjson";
    }
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

class LynxFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> };
  constructor(result: LynxFetchSuccess) {
    const status = Number(result.status ?? 0);
    const streamingId = result.lynxExtension?.streamingId;
    const reader =
      streamingId != null && streamingId.length > 0
        ? streamingReader(streamingId)
        : readerFromChunks(result.body == null ? [] : [toUint8(result.body)]);
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
    return decodeUtf8(copyToArrayBuffer(joined));
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

function streamingReader(eventName: string): ReadableStreamDefaultReader<Uint8Array> {
  const queue: Uint8Array[] = [];
  let finished = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let emitter: { addListener(name: string, fn: (payload: unknown) => void): void } | undefined;
  try {
    // Bare `lynx` so the Lynx bundler keeps the runtime global (eval/globalThis miss it).
    emitter = (
      lynx as {
        getJSModule?: (name: string) => { addListener(name: string, fn: (payload: unknown) => void): void };
      }
    ).getJSModule?.("GlobalEventEmitter");
  } catch {
    emitter = (
      globalThis as unknown as {
        lynx?: { getJSModule?: (name: string) => { addListener(name: string, fn: (payload: unknown) => void): void } };
      }
    ).lynx?.getJSModule?.("GlobalEventEmitter");
  }
  if (emitter == null) {
    throw new Error("GlobalEventEmitter is not registered");
  }
  const onEvent = (payload: unknown) => {
    const event =
      payload != null && typeof payload === "object" && "event" in payload
        ? String((payload as { event?: unknown }).event)
        : "";
    const data =
      payload != null && typeof payload === "object" && "data" in payload
        ? (payload as { data?: unknown }).data
        : undefined;
    const error =
      payload != null && typeof payload === "object" && "error" in payload
        ? (payload as { error?: unknown }).error
        : undefined;
    if (event === "onData") {
      queue.push(toUint8(data));
    } else if (event === "onEnd") {
      finished = true;
    } else if (event === "onError") {
      failure = new Error(error == null ? "Lynx HTTP stream error" : String(error));
      finished = true;
    }
    wake?.();
  };
  emitter.addListener(eventName, onEvent);
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
      wake?.();
      return Promise.resolve();
    },
    releaseLock() {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

function unwrapFetchSuccess(result: unknown): LynxFetchSuccess {
  if (Array.isArray(result) && result.length > 0 && result[0] != null && typeof result[0] === "object") {
    return result[0] as LynxFetchSuccess;
  }
  return (result ?? {}) as LynxFetchSuccess;
}

function moduleResponse(result: LynxFetchSuccess): Response {
  return new LynxFetchResponse(result) as unknown as Response;
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
  return { useStreaming: true, enableFetchAPIStandardStreaming: true };
}

/**
 * Lynx streaming Response.body is one-shot. AbstractRemote checks `res.body`
 * then calls `res.body.getReader()`; a second getter throws "body used".
 */
function stabilizeStreamingResponse(response: Response): Response {
  const captured = response.body;
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
  } as Response;
}

function fetchViaLynxModule(resource: string, request: RequestInit): Promise<Response> {
  const native = lynxFetchModule();
  if (native == null) {
    throw new Error("LynxFetchModule is not registered");
  }
  const headers = headerMap(request.headers);
  const payload: Record<string, unknown> = {
    method: String(request.method ?? "GET"),
    url: resource,
    headers,
    lynxExtension: { enableFetchAPIStandardStreaming: true },
  };
  if (typeof request.body === "string") {
    payload.body = encodeUtf8(request.body);
  }
  return new Promise((resolve, reject) => {
    native.fetch(
      payload,
      (result) => {
        try {
          resolve(moduleResponse(unwrapFetchSuccess(result)));
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
    if (isLynxAndroid() && lynxFetchModule() != null) {
      return fetchViaLynxModule(url, request);
    }
    const init: RequestInit & { lynxExtension?: Record<string, boolean> } = {
      method: request.method ?? "GET",
      headers: headerMap(request.headers),
    };
    if (typeof request.body === "string") {
      init.body = request.body;
    }
    const extension = streamingExtension(expectStreamingResponse);
    if (Object.keys(extension).length > 0) {
      init.lynxExtension = extension;
    }
    // PrimJS puts fetch on the identifier, not always on globalThis (iOS).
    const fromGlobal = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    const response = await (typeof fromGlobal === "function" ? fromGlobal : fetch)(url, init);
    const streamingId = (response as Response & { lynxExtension?: { streamingId?: string } }).lynxExtension
      ?.streamingId;
    if (streamingId != null && streamingId.length > 0) {
      return moduleResponse({
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": response.headers?.get("content-type") ?? "" },
        lynxExtension: { streamingId },
      });
    }
    return stabilizeStreamingResponse(response);
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
