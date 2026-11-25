import type { FetchOptions } from "@powersync/shared-internals";
import { isString } from "../../type-guards.ts";
import { hostFetchTransport } from "./HostFetch.ts";
import { lynxFetchModuleAvailable, lynxFetchModuleTransport } from "./LynxFetchModule.ts";
import { nativeHttpFetchAvailable, nativeHttpFetchTransport } from "./NativeHttpFetch.ts";

/**
 * One deep `/sync/stream` seam: URL / headers / body / abort in, streaming
 * `Response` out. Fits `AbstractRemote.fetch` (`FetchOptions`).
 */
export interface SyncStreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  expectStreamingResponse: boolean;
}

export type SyncStreamTransportName = "native-http" | "lynx-fetch-module" | "host-fetch";

export interface SyncStreamTransport {
  readonly name: SyncStreamTransportName;
  fetch(request: SyncStreamRequest): Promise<Response>;
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

interface HeaderFields {
  readonly [name: string]: string | undefined;
}

/** Copy header pairs only. NDJSON Accept policy is {@link preferNdjsonAccept}. */
export function headerMap(headers: HeadersInit | undefined) {
  const out: Record<string, string> = {};
  if (headers == null) {
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (pair != null && pair.length >= 2 && pair[0] != null && pair[1] != null) {
        out[String(pair[0])] = String(pair[1]);
      }
    }
    return out;
  }
  // SAFETY: remaining HeadersInit after the array branch is a string header record.
  const rec = headers as HeaderFields;
  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}

export function syncStreamRequestFromFetch(options: FetchOptions): SyncStreamRequest {
  const request: SyncStreamRequest = {
    url: String(options.resource),
    method: String(options.request.method ?? "GET"),
    headers: preferNdjsonAccept(headerMap(options.request.headers)),
    expectStreamingResponse: options.expectStreamingResponse,
  };
  const body = options.request.body;
  if (isString(body)) {
    request.body = body;
  }
  const signal = options.request.signal;
  if (signal != null) {
    request.signal = signal;
  }
  return request;
}

/**
 * Native httpFetch is primary for streaming (streamingId realtime path).
 * Desktop N-API has no httpFetch — pick falls through to host-fetch.
 * LynxFetchModule is the Android JSON adapter only (ADR-0004); never a stream
 * transport. Identifier fetch is Lynx-for-Web / iOS JSON / desktop.
 */
export function pickSyncStreamTransport(request: SyncStreamRequest): SyncStreamTransport {
  if (request.expectStreamingResponse && nativeHttpFetchAvailable()) {
    return nativeHttpFetchTransport;
  }
  if (!request.expectStreamingResponse && lynxFetchModuleAvailable()) {
    return lynxFetchModuleTransport;
  }
  return hostFetchTransport;
}
