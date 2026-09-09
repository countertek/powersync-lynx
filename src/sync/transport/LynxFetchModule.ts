import { getLynxHost, hostIsAndroid } from "../../host.ts";
import { isNonNullObject } from "../../type-guards.ts";
import { copyHeaderRecord, encodeUtf8, toUint8 } from "./bytes.ts";
import type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";
import { syncStreamResponse } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

export type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";

function lynxFetchModule(): LynxFetchModule | undefined {
  return getLynxHost().nativeModules()?.LynxFetchModule;
}

export function lynxFetchModuleAvailable(): boolean {
  return hostIsAndroid() && lynxFetchModule() != null;
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

/** LynxFetchModule success payload → finished JSON Response. This adapter never streams. */
export function responseFromLynxFetchSuccess(result: LynxFetchSuccessPayload) {
  const payload = unwrapLynxSuccess(result);
  return syncStreamResponse({
    status: Number(payload.status ?? 0),
    statusText: String(payload.statusText ?? ""),
    headers: copyHeaderRecord(payload.headers),
    bytes: toUint8(payload.body),
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
  if (request.body != null) {
    payload.body = encodeUtf8(request.body);
  }
  return new Promise((resolve, reject) => {
    native.fetch(
      payload,
      (result) => {
        try {
          resolve(responseFromLynxFetchSuccess(result));
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

/** Android JSON adapter (write-checkpoint, gzip-as-binary-string). Never a stream transport. */
export const lynxFetchModuleTransport: SyncStreamTransport = {
  name: "lynx-fetch-module",
  fetch: fetchViaLynxModule,
};
