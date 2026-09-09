import { getLynxHost } from "../../host.ts";
import { isString } from "../../type-guards.ts";
import type {
  NativeHttpFetchEnvelope,
  NativeHttpFetchRequest,
  NativeSyncHttpModule,
} from "./http-types.ts";
import { enterEarlyCapture } from "./events.ts";
import { fromNativeHttpEnvelope, moduleResponse, unwrapFetchSuccess } from "./response.ts";
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
  const signal = request.signal;
  if (signal != null) {
    if (signal.aborted) {
      abortNative();
    } else {
      signal.addEventListener("abort", abortNative, { once: true });
    }
  }
  return new Promise((resolve, reject) => {
    // Direct call like SQL RPC (open/execute). Do not use .call/.apply — PrimJS host
    // methods may not be JS Function objects.
    httpFetch(payload, (envelope: NativeHttpFetchEnvelope) => {
      try {
        // SAFETY: Native Callback hands NativeHttpFetchEnvelope; unwrap only peels a PrimJS array wrap.
        const result = unwrapFetchSuccess(envelope) as NativeHttpFetchEnvelope;
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
        resolve(moduleResponse(fromNativeHttpEnvelope(result), false));
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
