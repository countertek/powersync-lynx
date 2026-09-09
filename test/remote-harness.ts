import type { PowerSyncBackendConnector, PowerSyncLogger } from "@powersync/common";

import type { NativeModulesHost, NativePowerSyncModule } from "../src/adapter/native.ts";
import type { NativeSyncHttpModule } from "../src/sync/transport/http-types.ts";
import { createFakeEmitter, withFakeLynxHost, type FakeLynxHostState } from "./fake-lynx-host.ts";

export { createFakeEmitter, withFakeLynxHost };
export type { FakeLynxHostState };

export const silentLogger: PowerSyncLogger = {
  log() {},
};

export function stubConnector(
  fetchCredentials: PowerSyncBackendConnector["fetchCredentials"] = async () => null,
): PowerSyncBackendConnector {
  return {
    fetchCredentials,
    uploadData: async () => {},
  };
}

export function demoConnector(endpoint: string): PowerSyncBackendConnector {
  return stubConnector(async () => ({ endpoint, token: "tok" }));
}

function sqlNoops(): NativePowerSyncModule {
  return {
    open(_options, callback) {
      callback({ ok: true, dbId: "test" });
    },
    close(_dbId, callback) {
      callback({ ok: true });
    },
    execute(_dbId, _sql, _params, callback) {
      callback({ ok: true });
    },
    executeBatch(_dbId, _sql, _params, callback) {
      callback({ ok: true });
    },
  };
}

export function nativeWithHttp(
  extra: Partial<NativeSyncHttpModule> = {},
): NativePowerSyncModule & Partial<NativeSyncHttpModule> {
  return { ...sqlNoops(), ...extra };
}

export function assignNativeModules(host: NativeModulesHost): void {
  globalThis.NativeModules = host;
}

export interface MockStreamReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export interface MockReadableBody {
  getReader(): MockStreamReader;
}

export function chunkReader(chunks: Uint8Array[]): MockReadableBody {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index < chunks.length) {
            const value = chunks[index]!;
            index += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
        cancel() {
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
}

export interface IdentifierResponseOptions {
  status?: number;
  statusText?: string;
  contentType?: string;
  mockBody?: MockReadableBody | null;
  streamingId?: string;
  bodyUsedError?: boolean;
  inspectOnce?: boolean;
  text?: () => Promise<string>;
}

export function identifierResponse(options: IdentifierResponseOptions = {}): Response {
  const headers = new Headers();
  const contentType = options.contentType;
  if (contentType != null && contentType.length > 0) {
    headers.set("content-type", contentType);
  }
  const response = new Response(null, {
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers,
  });
  if (options.streamingId != null) {
    Object.defineProperty(response, "lynxExtension", {
      value: { streamingId: options.streamingId },
    });
  }
  if (options.bodyUsedError === true) {
    Object.defineProperty(response, "body", {
      configurable: true,
      get() {
        throw new Error("body used");
      },
    });
  } else if (options.inspectOnce === true) {
    const stream = options.mockBody ?? null;
    let reads = 0;
    Object.defineProperty(response, "body", {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("body used");
        }
        return stream;
      },
    });
  } else if (options.mockBody !== undefined) {
    Object.defineProperty(response, "body", {
      configurable: true,
      value: options.mockBody,
    });
  }
  if (options.text != null) {
    Object.defineProperty(response, "text", { value: options.text });
  }
  return response;
}

export function hangResponse(): Promise<Response> {
  return new Promise(() => {});
}

export function lynxStreamingRequested(init: RequestInit | undefined): boolean {
  if (init == null) {
    return false;
  }
  // SAFETY: Lynx fetch RequestInit carries lynxExtension; DOM RequestInit does not declare it.
  const extra = init as RequestInit & {
    lynxExtension?: { enableFetchAPIStandardStreaming?: boolean };
  };
  return extra.lynxExtension?.enableFetchAPIStandardStreaming === true;
}
