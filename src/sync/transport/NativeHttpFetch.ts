import { getLynxHost } from "../../host.ts";
import { isNonNullObject, isString } from "../../type-guards.ts";
import type {
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
  NativeSyncHttpModule,
} from "./http-types.ts";
import { decodeBase64, toUint8 } from "./bytes.ts";
import { enterEarlyCapture } from "./events.ts";
import { syncStreamResponse } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

export type {
  NativeHttpFetchCallback,
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
  NativeSyncHttpModule,
} from "./http-types.ts";

/**
 * HTTP methods live on the Autolink SQL module object on iOS/Android.
 * Desktop N-API is SQL-only — `httpFetch` is absent.
 */
export function lookupNativeSyncHttp(): NativeSyncHttpModule | undefined {
  const sql = getLynxHost().nativeModules()?.NativePowerSyncModule;
  if (sql == null) {
    return undefined;
  }
  const httpFetch = sql.httpFetch;
  if (httpFetch == null) {
    return undefined;
  }
  const module: NativeSyncHttpModule = { httpFetch };
  if (sql.httpFetchAbort != null) {
    module.httpFetchAbort = sql.httpFetchAbort;
  }
  return module;
}

export function nativeHttpFetchAvailable(): boolean {
  return lookupNativeSyncHttp() != null;
}

function unwrapNativeEnvelope(envelope: NativeHttpFetchEnvelope): NativeHttpFetchEnvelope {
  if (!Array.isArray(envelope) || envelope.length === 0) {
    return envelope;
  }
  const first = envelope[0];
  if (!isNonNullObject(first)) {
    return {};
  }
  // SAFETY: PrimJS may wrap the httpFetch callback argument in a one-element array.
  return first as NativeHttpFetchEnvelope;
}

function contentTypeFromEnvelope(result: NativeHttpFetchEnvelope): string {
  if (isString(result.contentType) && result.contentType.length > 0) {
    return result.contentType;
  }
  return "application/x-ndjson";
}

/** Native `httpFetch` envelope → finished Response. This adapter owns the wire shape. */
export function responseFromNativeHttpEnvelope(result: NativeHttpFetchEnvelope) {
  const status = Number(result.status ?? 0);
  const statusText = String(result.statusText ?? "");
  const headers = { "content-type": contentTypeFromEnvelope(result) };
  const streamingId =
    isString(result.streamingId) && result.streamingId.length > 0 ? result.streamingId : undefined;
  if (streamingId != null) {
    return syncStreamResponse({
      status,
      statusText,
      headers,
      streamingId,
    });
  }
  const bodyText = isString(result.body) ? result.body : "";
  let bytes = toUint8(bodyText);
  if (bytes.byteLength === 0 && isString(result.bodyBase64) && result.bodyBase64.length > 0) {
    bytes = decodeBase64(result.bodyBase64);
  }
  return syncStreamResponse({
    status,
    statusText,
    headers,
    bytes,
  });
}

function fetchViaNativeHttp(request: SyncStreamRequest): Promise<Response> {
  const native = lookupNativeSyncHttp();
  if (native == null) {
    throw new Error("Native Module HTTP (httpFetch) is not registered");
  }
  const httpFetch = native.httpFetch;
  const payload: NativeHttpFetchRequest = {
    method: request.method,
    url: request.url,
    headers: request.headers,
  };
  if (request.body != null) {
    payload.body = request.body;
  }
  const signal = request.signal;
  if (signal != null && signal.aborted) {
    return Promise.reject(new Error("Aborted"));
  }
  // Capture GlobalEventEmitter early — native may emit onData before the Callback returns.
  enterEarlyCapture();
  let streamIdForAbort: string | undefined;
  let aborted = false;
  const abortNative = () => {
    aborted = true;
    const abortFn = native.httpFetchAbort;
    if (abortFn == null || streamIdForAbort == null) {
      return;
    }
    try {
      abortFn(streamIdForAbort, () => {});
    } catch {
      // Presence-only; PrimJS host methods may throw on unused abort.
    }
  };
  if (signal != null) {
    signal.addEventListener("abort", abortNative, { once: true });
  }
  return new Promise((resolve, reject) => {
    // Direct call like SQL RPC (open/execute). Do not use .call/.apply — PrimJS host
    // methods may not be JS Function objects.
    httpFetch(payload, (envelope: NativeHttpFetchEnvelope) => {
      try {
        const result = unwrapNativeEnvelope(envelope);
        if (result.ok === false) {
          reject(new Error(result.message ?? "Native Module HTTP httpFetch failed"));
          return;
        }
        const streamingId =
          isString(result.streamingId) && result.streamingId.length > 0
            ? result.streamingId
            : undefined;
        if (streamingId != null) {
          streamIdForAbort = streamingId;
          if (aborted) {
            abortNative();
          }
        }
        resolve(responseFromNativeHttpEnvelope(result));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Primary native `/sync/stream` path: Native Module HTTP (`httpFetch`) plus
 * GlobalEventEmitter chunks keyed by streamingId (issue #21). Idle-complete
 * UTF-8 body is a fallback when no streamingId is returned.
 */
export const nativeHttpFetchTransport: SyncStreamTransport = {
  name: "native-http",
  fetch: fetchViaNativeHttp,
};
