import { getLynxHost, hostIsAndroid } from "../../host.ts";
import type { LynxFetchRequest } from "../../adapter/native.ts";
import { encodeUtf8 } from "./bytes.ts";
import { moduleResponse, unwrapFetchSuccess } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

interface LynxStreamingFlags {
  enableFetchAPIStandardStreaming?: boolean;
}

function lynxFetchModule() {
  return getLynxHost().nativeModules()?.LynxFetchModule;
}

export function lynxFetchModuleAvailable(): boolean {
  return hostIsAndroid() && lynxFetchModule() != null;
}

/**
 * Android showcase: ShowcaseLynxHttpService idle-completes non-streaming
 * `/sync/stream` and stashes NDJSON as powersyncIdleBodyBase64. Requesting
 * standard streaming here previously yielded streamingId:null + empty body
 * while JS waited on nameless GlobalEventEmitter fallback — ps_buckets
 * stayed 0. Force the buffered handoff on Android.
 *
 * Do NOT set useStreaming: that selects Lynx's deprecated CRLF chunked parser,
 * which mis-parses PowerSync NDJSON (LF-only).
 */
export function streamingExtension(expectStreamingResponse: boolean): LynxStreamingFlags {
  if (!expectStreamingResponse) {
    return {};
  }
  if (hostIsAndroid()) {
    return {};
  }
  return { enableFetchAPIStandardStreaming: true };
}

function fetchViaLynxModule(request: SyncStreamRequest): Promise<Response> {
  const native = lynxFetchModule();
  if (native == null) {
    throw new Error("LynxFetchModule is not registered");
  }
  const payload: LynxFetchRequest = {
    method: request.method,
    url: request.url,
    headers: request.headers,
  };
  const extension = streamingExtension(request.expectStreamingResponse);
  if (Object.keys(extension).length > 0) {
    payload.lynxExtension = extension;
  }
  if (request.body != null) {
    payload.body = encodeUtf8(request.body);
  }
  return new Promise((resolve, reject) => {
    native.fetch(
      payload,
      (result) => {
        try {
          resolve(moduleResponse(unwrapFetchSuccess(result), request.expectStreamingResponse));
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

/** Fallback when NativePowerSyncModule.httpFetch is absent (Android LynxFetchModule). */
export const lynxFetchModuleTransport: SyncStreamTransport = {
  name: "lynx-fetch-module",
  fetch: fetchViaLynxModule,
};
