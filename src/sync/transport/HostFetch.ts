import { getLynxHost } from "../../host.ts";
import { isFunction } from "../../type-guards.ts";
import {
  stabilizeJsonResponse,
  stabilizeStreamingResponse,
  syncStreamResponse,
} from "./response.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

interface LynxRequestInit extends RequestInit {
  lynxExtension?: {
    enableFetchAPIStandardStreaming?: boolean;
  };
}

function emptyStreamResponse(response: Response): Response {
  const contentType = response.headers?.get("content-type") ?? "";
  return syncStreamResponse({
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": contentType },
    bytes: new Uint8Array(0),
  });
}

/**
 * Keep a usable Fetch body. Do not inspect `lynxExtension.streamingId` —
 * that native extension is owned by NativeHttpFetch. LynxFetchModule is
 * JSON-only and is never picked for streaming (ADR-0004).
 */
function hostStreamingResponse(response: Response): Response {
  let captured: Response["body"];
  try {
    captured = response.body;
  } catch {
    return emptyStreamResponse(response);
  }
  if (captured != null && isFunction(captured.getReader)) {
    return stabilizeStreamingResponse(response, captured);
  }
  return emptyStreamResponse(response);
}

async function fetchViaHost(request: SyncStreamRequest): Promise<Response> {
  const fetchImpl = getLynxHost().fetchImpl();
  if (fetchImpl == null) {
    throw new Error("fetch is not available");
  }
  const init: LynxRequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.body != null) {
    init.body = request.body;
  }
  if (request.expectStreamingResponse) {
    init.lynxExtension = { enableFetchAPIStandardStreaming: true };
  }
  const response = await fetchImpl(request.url, init);
  if (!request.expectStreamingResponse) {
    return stabilizeJsonResponse(response);
  }
  return hostStreamingResponse(response);
}

/** Lynx-for-Web / desktop identifier `fetch` (browser or PrimJS fetch). */
export const hostFetchTransport: SyncStreamTransport = {
  name: "host-fetch",
  fetch: fetchViaHost,
};
