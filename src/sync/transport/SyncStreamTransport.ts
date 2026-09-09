import type { FetchOptions } from "@powersync/shared-internals";
import { isString } from "../../type-guards.ts";
import { headerMap } from "./bytes.ts";
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

export function syncStreamRequestFromFetch(options: FetchOptions): SyncStreamRequest {
  const request: SyncStreamRequest = {
    url: String(options.resource),
    method: String(options.request.method ?? "GET"),
    headers: headerMap(options.request.headers),
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
 * LynxFetchModule is the Android fallback. Identifier fetch is Lynx-for-Web /
 * iOS JSON / desktop.
 */
export function pickSyncStreamTransport(request: SyncStreamRequest): SyncStreamTransport {
  if (request.expectStreamingResponse && nativeHttpFetchAvailable()) {
    return nativeHttpFetchTransport;
  }
  if (lynxFetchModuleAvailable()) {
    return lynxFetchModuleTransport;
  }
  return hostFetchTransport;
}
