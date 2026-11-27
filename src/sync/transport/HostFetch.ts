import { getLynxHost } from "../../host.ts";
import { isFunction, isNonNullObject, isString } from "../../type-guards.ts";
import { parseJsonText, syncStreamResponse, type ParsedJsonValue } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

interface LynxRequestInit extends RequestInit {
  lynxExtension?: {
    enableFetchAPIStandardStreaming?: boolean;
  };
}

interface IdentifierJsonMethods {
  json?: () => Promise<ParsedJsonValue | string>;
  text?: () => Promise<string>;
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

async function decodeIdentifierJson(response: Response): Promise<ParsedJsonValue> {
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

/**
 * Lynx streaming Response.body is one-shot. AbstractRemote checks `res.body`
 * then calls `res.body.getReader()`; a second getter throws "body used".
 */
function stabilizeStreamingResponse(response: Response, capturedBody?: Response["body"]): Response {
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
function stabilizeJsonResponse(response: Response): Response {
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

function emptyStreamResponse(response: Response): Response {
  const contentType = response.headers?.get("content-type") ?? "";
  return syncStreamResponse({
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": contentType },
    bytes: new Uint8Array(0),
  });
}

/**
 * Keep a usable Fetch body. Do not inspect `lynxExtension.streamingId` —
 * that native extension is owned by NativeHttpFetch. LynxFetchModule is
 * JSON-only and is never picked for streaming (ADR-0004).
 */
function hostStreamingResponse(response: Response): Response {
  let captured: Response["body"];
  try {
    captured = response.body;
  } catch {
    return emptyStreamResponse(response);
  }
  if (captured != null && isFunction(captured.getReader)) {
    return stabilizeStreamingResponse(response, captured);
  }
  return emptyStreamResponse(response);
}

async function fetchViaHost(request: SyncStreamRequest): Promise<Response> {
  const fetchImpl = getLynxHost().fetchImpl();
  if (fetchImpl == null) {
    throw new Error("fetch is not available");
  }
  const init: LynxRequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.body != null) {
    init.body = request.body;
  }
  if (request.signal != null) {
    init.signal = request.signal;
  }
  if (request.expectStreamingResponse) {
    init.lynxExtension = { enableFetchAPIStandardStreaming: true };
  }
  const response = await fetchImpl(request.url, init);
  if (!request.expectStreamingResponse) {
    return stabilizeJsonResponse(response);
  }
  return hostStreamingResponse(response);
}

/** Lynx-for-Web / desktop identifier `fetch` (browser or PrimJS fetch). */
export const hostFetchTransport: SyncStreamTransport = {
  name: "host-fetch",
  fetch: fetchViaHost,
};
