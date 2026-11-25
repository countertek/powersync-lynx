import { isFunction, isNonNullObject, isString } from "../../type-guards.ts";
import { copyToArrayBuffer } from "../../values.ts";
import { gunzipSync, isGzip } from "../gunzip.ts";
import { decodeUtf8, latin1Bytes } from "./bytes.ts";

interface HeaderFields {
  readonly [name: string]: string | undefined;
}

function copyHeaderRecord(headers: HeaderFields | undefined) {
  const lower: Record<string, string> = {};
  if (headers == null) {
    return lower;
  }
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value == null) {
      continue;
    }
    lower[key.toLowerCase()] = String(value);
  }
  return lower;
}

/**
 * One internal Response constructor. Adapters interpret their own wire shape
 * and pass either buffered bytes or a stream reader.
 */
export type SyncStreamResponseInit = {
  status?: number;
  statusText?: string;
  headers?: HeaderFields;
} & ({ bytes: Uint8Array } | { reader: ReadableStreamDefaultReader<Uint8Array> });

function readerFromChunks(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  // SAFETY: chunk reader implements the ReadableStreamDefaultReader methods AbstractRemote calls.
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

function readerForInit(init: SyncStreamResponseInit): ReadableStreamDefaultReader<Uint8Array> {
  if ("reader" in init) {
    return init.reader;
  }
  if (init.bytes.byteLength > 0) {
    return readerFromChunks([init.bytes]);
  }
  return readerFromChunks([]);
}

class SyncStreamBodyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> };

  constructor(init: SyncStreamResponseInit) {
    const status = Number(init.status ?? 0);
    const reader = readerForInit(init);
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.statusText = String(init.statusText ?? "");
    const headers = copyHeaderRecord(init.headers);
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

  async json() {
    return parseJsonText(await this.text());
  }
}

/**
 * Finished `/sync/stream` Response from adapter-owned bytes or stream reader.
 */
export function syncStreamResponse(init: SyncStreamResponseInit): Response {
  // SAFETY: SyncStreamBodyResponse implements the Response fields AbstractRemote
  // reads (ok, status, statusText, headers, body, text, json).
  return new SyncStreamBodyResponse(init) as Response;
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
  // SAFETY: Host fetch bodies are one-shot; this wrapper is the Response AbstractRemote reads.
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
  // SAFETY: JSON GETs must not consume Response.body; this wrapper is the Response AbstractRemote reads.
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

function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

interface ParsedJsonValue {
  readonly [key: string]: ParsedJsonValue | string | number | boolean | null | undefined;
}

function isParsedJsonValue(value: unknown): value is ParsedJsonValue {
  if (!isNonNullObject(value)) {
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

function parseJsonText(text: string) {
  const trimmed = stripBom(text).trim();
  if (trimmed.length === 0 || trimmed === "undefined") {
    return { data: {} };
  }
  const raw = latin1Bytes(trimmed);
  if (isGzip(raw)) {
    const inflated = gunzipSync(raw);
    // SAFETY: write-checkpoint / identifier JSON is an object after gunzip + UTF-8.
    return JSON.parse(stripBom(decodeUtf8(copyToArrayBuffer(inflated))).trim()) as ParsedJsonValue;
  }
  // SAFETY: write-checkpoint / identifier JSON text parses to an object (empty already handled).
  return JSON.parse(trimmed) as ParsedJsonValue;
}

interface IdentifierJsonObject {
  readonly [key: string]: IdentifierJsonObject | string | number | boolean | null | undefined;
}

interface IdentifierJsonMethods {
  json?: () => Promise<IdentifierJsonObject | string>;
  text?: () => Promise<string>;
}

async function decodeIdentifierJson(response: Response) {
  // SAFETY: identifier fetch may expose json()/text() beyond the DOM Response typedef.
  const extra = response as Response & IdentifierJsonMethods;
  if (isFunction(extra.json)) {
    try {
      const value = await extra.json();
      if (isParsedJsonValue(value)) {
        return value;
      }
      if (isString(value)) {
        return parseJsonText(value);
      }
    } catch {
      // Lynx json() throws on the string undefined or gzip magic.
    }
  }
  if (isFunction(extra.text)) {
    return parseJsonText(await extra.text());
  }
  return { data: {} };
}
