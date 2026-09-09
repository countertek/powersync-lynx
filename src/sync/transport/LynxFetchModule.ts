import { getLynxHost, hostIsAndroid } from "../../host.ts";
import { isNonNullObject, isString } from "../../type-guards.ts";
import { copyHeaderRecord, encodeUtf8, toUint8 } from "./bytes.ts";
import type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";
import { syncStreamResponse } from "./response.ts";
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

function unwrapLynxSuccess(result: LynxFetchSuccessPayload): LynxFetchSuccessPayload {
  if (!Array.isArray(result) || result.length === 0) {
    return result;
  }
  const first = result[0];
  if (!isNonNullObject(first)) {
    return {};
  }
  // SAFETY: PrimJS may wrap the LynxFetchModule success callback in a one-element array.
  return first as LynxFetchSuccessPayload;
}

/** LynxFetchModule success payload → finished Response. This adapter owns lynxExtension. */
export function responseFromLynxFetchSuccess(
  result: LynxFetchSuccessPayload,
  expectStreamingResponse: boolean,
) {
  const payload = unwrapLynxSuccess(result);
  const status = Number(payload.status ?? 0);
  const statusText = String(payload.statusText ?? "");
  const headers = copyHeaderRecord(payload.headers);
  const streamingId = payload.lynxExtension?.streamingId;
  const bytes = toUint8(payload.body);
  if (isString(streamingId) && streamingId.length > 0 && bytes.byteLength === 0) {
    return syncStreamResponse({
      status,
      statusText,
      headers,
      streamingId,
    });
  }
  if (bytes.byteLength > 0) {
    return syncStreamResponse({
      status,
      statusText,
      headers,
      bytes,
    });
  }
  if (expectStreamingResponse) {
    return syncStreamResponse({
      status,
      statusText,
      headers,
      streamingFallback: true,
    });
  }
  return syncStreamResponse({
    status,
    statusText,
    headers,
    bytes,
  });
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
          resolve(responseFromLynxFetchSuccess(result, request.expectStreamingResponse));
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
