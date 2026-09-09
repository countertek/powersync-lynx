import { getLynxHost } from "../../host.ts";
import { isString } from "../../type-guards.ts";
import type { NativeHttpFetchEnvelope, NativeHttpFetchRequest } from "../../adapter/native.ts";
import { enterEarlyCapture } from "./events.ts";
import { moduleResponse, unwrapFetchSuccess, type WireFetchSuccess } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

function nativeHttpFetchModule() {
  return getLynxHost().nativeModules()?.NativePowerSyncModule;
}

export function nativeHttpFetchAvailable(): boolean {
  return nativeHttpFetchModule() != null;
}

function streamingResponseFromEnvelope(result: NativeHttpFetchEnvelope): WireFetchSuccess {
  const status = Number(result.status ?? 0);
  const streamingId =
    isString(result.streamingId) && result.streamingId.length > 0 ? result.streamingId : undefined;
  if (streamingId != null) {
    return {
      status,
      statusText: String(result.statusText ?? ""),
      headers: {
        "content-type":
          isString(result.contentType) && result.contentType.length > 0
            ? result.contentType
            : "application/x-ndjson",
      },
      body: "",
      lynxExtension: {
        streamingId,
        powersyncIdleComplete: false,
      },
    };
  }
  const bodyText = isString(result.body) ? result.body : "";
  return {
    status,
    statusText: String(result.statusText ?? ""),
    headers: {
      "content-type":
        isString(result.contentType) && result.contentType.length > 0
          ? result.contentType
          : "application/x-ndjson",
    },
    body: bodyText,
    lynxExtension: {
      powersyncIdleComplete: result.idleComplete === true || bodyText.length > 0,
      powersyncIdleBodyBase64: isString(result.bodyBase64) ? result.bodyBase64 : undefined,
    },
  };
}

function fetchViaNativeHttp(request: SyncStreamRequest): Promise<Response> {
  const native = nativeHttpFetchModule();
  if (native == null) {
    throw new Error("NativePowerSyncModule.httpFetch is not registered");
  }
  const httpFetch = native.httpFetch;
  if (httpFetch == null) {
    throw new Error("NativePowerSyncModule.httpFetch is missing");
  }
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
          reject(new Error(result.message ?? "NativePowerSyncModule.httpFetch failed"));
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
        resolve(moduleResponse(streamingResponseFromEnvelope(result), false));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Primary native `/sync/stream` path: NativePowerSyncModule.httpFetch plus
 * GlobalEventEmitter chunks keyed by streamingId (issue #21). Idle-complete
 * UTF-8 body is a fallback when no streamingId is returned (issue #18 C later).
 */
export const nativeHttpFetchTransport: SyncStreamTransport = {
  name: "native-http",
  fetch: fetchViaNativeHttp,
};
