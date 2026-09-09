import type { LynxFetchSuccessPayload } from "../../adapter/native.ts";
import { copyToArrayBuffer } from "../../values.ts";
import { gunzipSync, isGzip } from "../gunzip.ts";
import {
  copyHeaderRecord,
  decodeBase64,
  decodeUtf8,
  isParsedJsonValue,
  parseJsonText,
  toUint8,
} from "./bytes.ts";
import { lookupEmitter, streamingReader, streamingReaderFallback } from "./events.ts";

export interface WireFetchSuccess {
  url?: string;
  body?: ArrayBuffer | Uint8Array | string;
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

/** Prefer direct body bytes; fall back to ShowcaseLynxHttpService idle-complete base64. */
function bodyFromFetchSuccess(result: WireFetchSuccess): Uint8Array {
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

export function readerFromChunks(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
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

class LynxFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> };
  private rawBody: unknown;
  constructor(result: WireFetchSuccess, streamingFallback = false) {
    const status = Number(result.status ?? 0);
    const streamingId = result.lynxExtension?.streamingId;
    const idleComplete = result.lynxExtension?.powersyncIdleComplete === true;
    const bodyBytes = bodyFromFetchSuccess(result);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    if (
      streamingId != null &&
      streamingId.length > 0 &&
      bodyBytes.byteLength === 0 &&
      !idleComplete
    ) {
      reader = streamingReader(streamingId);
    } else if (bodyBytes.byteLength > 0) {
      // Idle-complete / buffered body wins over nameless GlobalEventEmitter fallback.
      // Native may return ~19KB while JS sees streamingId:null — applying raw bytes is required
      // for ps_buckets > 0.
      reader = readerFromChunks([bodyBytes]);
    } else if (streamingFallback) {
      reader = streamingReaderFallback();
    } else {
      reader = readerFromChunks([]);
    }
    this.rawBody = bodyBytes.byteLength > 0 ? bodyBytes : result.body;
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.statusText = String(result.statusText ?? "");
    const headers = copyHeaderRecord(result.headers);
    this.headers = {
      get: (name: string) => headers[String(name).toLowerCase()] ?? null,
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

export function unwrapFetchSuccess(result: unknown): WireFetchSuccess {
  if (
    Array.isArray(result) &&
    result.length > 0 &&
    result[0] != null &&
    typeof result[0] === "object"
  ) {
    return result[0] as WireFetchSuccess;
  }
  return (result ?? {}) as WireFetchSuccess;
}

export function moduleResponse(result: WireFetchSuccess, streamingFallback = false): Response {
  return new LynxFetchResponse(result, streamingFallback) as unknown as Response;
}

export function fromLynxFetchSuccess(result: LynxFetchSuccessPayload): WireFetchSuccess {
  return result;
}

/**
 * Lynx streaming Response.body is one-shot. AbstractRemote checks `res.body`
 * then calls `res.body.getReader()`; a second getter throws "body used".
 */
export function stabilizeStreamingResponse(
  response: Response,
  capturedBody?: Response["body"],
): Response {
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
export function stabilizeJsonResponse(response: Response): Response {
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

export function eventStreamingResponse(response: Response, streamingId?: string): Response {
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

export async function identifierStreamingResponse(response: Response): Promise<Response> {
  const streamingId = (response as Response & { lynxExtension?: { streamingId?: string } })
    .lynxExtension?.streamingId;
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
  return stabilizeStreamingResponse(response, captured);
}
