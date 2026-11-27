import { getLynxHost, hostIsAndroid } from "../../host.ts";
import { isNonNullObject } from "../../type-guards.ts";
import { encodeUtf8, toUint8 } from "./bytes.ts";
import type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";
import { syncStreamResponse } from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

export type { LynxFetchModule, LynxFetchRequest, LynxFetchSuccessPayload } from "./http-types.ts";

function lynxFetchModule(): LynxFetchModule | undefined {
  return getLynxHost().lynxFetchModule();
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

function responseFromLynxFetchSuccess(result: LynxFetchSuccessPayload): Response {
  const payload = unwrapLynxSuccess(result);
  return syncStreamResponse({
    status: Number(payload.status ?? 0),
    statusText: String(payload.statusText ?? ""),
    headers: payload.headers,
    bytes: toUint8(payload.body),
  });
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function fetchViaLynxModule(request: SyncStreamRequest): Promise<Response> {
  const native = lynxFetchModule();
  if (native == null) {
    throw new Error("LynxFetchModule is not registered");
  }
  const signal = request.signal;
  if (signal != null && signal.aborted) {
    return Promise.reject(abortError());
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
    let settled = false;

    const onAbort = (): void => {
      settleReject(abortError());
    };

    const detachAbort = (): void => {
      if (signal != null) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const settleResolve = (response: Response): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachAbort();
      resolve(response);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachAbort();
      reject(error);
    };

    if (signal != null) {
      signal.addEventListener("abort", onAbort);
    }

    native.fetch(
      payload,
      (result) => {
        try {
          settleResolve(responseFromLynxFetchSuccess(result));
        } catch (err) {
          settleReject(err instanceof Error ? err : new Error("LynxFetchModule.fetch failed"));
        }
      },
      (error) => {
        settleReject(new Error(error?.message ?? "LynxFetchModule.fetch failed"));
      },
    );
  });
}

/** Android JSON adapter (write-checkpoint, gzip-as-binary-string). Never a stream transport. */
export const lynxFetchModuleTransport: SyncStreamTransport = {
  name: "lynx-fetch-module",
  fetch: fetchViaLynxModule,
};
