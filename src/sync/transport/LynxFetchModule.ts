import { getLynxHost, hostIsAndroid } from "../../host.ts";
import { encodeUtf8 } from "./bytes.ts";
import type { LynxFetchModule, LynxFetchRequest } from "./http-types.ts";
import { fromLynxFetchSuccess, moduleResponse } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

export type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";

interface LynxStreamingFlags {
  enableFetchAPIStandardStreaming?: boolean;
}

function lynxFetchModule(): LynxFetchModule | undefined {
  return getLynxHost().nativeModules()?.LynxFetchModule;
}

export function lynxFetchModuleAvailable(): boolean {
  return hostIsAndroid() && lynxFetchModule() != null;
}

/**
 * Android LynxFetchModule: do not request standard streaming for
 * `/sync/stream`. That previously yielded streamingId:null + empty body
 * while JS waited on nameless GlobalEventEmitter fallback.
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
          resolve(moduleResponse(fromLynxFetchSuccess(result), request.expectStreamingResponse));
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

/** Fallback when Native Module HTTP is absent (Android LynxFetchModule). */
export const lynxFetchModuleTransport: SyncStreamTransport = {
  name: "lynx-fetch-module",
  fetch: fetchViaLynxModule,
};
