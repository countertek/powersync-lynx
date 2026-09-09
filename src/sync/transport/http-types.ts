/**
 * Native Module HTTP + LynxFetchModule wire types.
 *
 * SQL RPC types live in `src/adapter/native.ts`. These types are the sync
 * HTTP seam (ADR-0003): Autolink still looks up `NativePowerSyncModule`, but
 * `httpFetch` is not `callNative`.
 */

export interface NativeHttpFetchRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * One envelope for native `httpFetch`: streaming callback (`streamingId`, empty
 * body), idle-complete fallback (`body` UTF-8, optional `bodyBase64`), or
 * pre-headers failure (`ok: false`, `status: -1`, `message`).
 */
export interface NativeHttpFetchEnvelope {
  ok?: boolean;
  message?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  bodyBase64?: string;
  idleComplete?: boolean;
  streamingId?: string;
}

export type NativeHttpFetchCallback = (envelope: NativeHttpFetchEnvelope) => void;

export interface NativeSyncHttpModule {
  httpFetch(request: NativeHttpFetchRequest, callback: NativeHttpFetchCallback): void;
  httpFetchAbort?(streamId: string, callback: NativeHttpFetchCallback): void;
}

export interface LynxFetchRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  lynxExtension?: {
    enableFetchAPIStandardStreaming?: boolean;
    useStreaming?: boolean;
  };
}

export interface LynxFetchSuccessPayload {
  url?: string;
  body?: ArrayBuffer | Uint8Array | string;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
  lynxExtension?: {
    streamingId?: string;
    enableFetchAPIStandardStreaming?: boolean;
  };
}

export interface LynxFetchModule {
  fetch(
    request: LynxFetchRequest,
    resolve: (response: LynxFetchSuccessPayload) => void,
    reject?: (error: { message?: string }) => void,
  ): void;
}
