import { getLynxHost } from "../../host.ts";
import { identifierStreamingResponse, stabilizeJsonResponse } from "./response.ts";
import { streamingExtension } from "./LynxFetchModule.ts";
import type { SyncStreamRequest, SyncStreamTransport } from "./SyncStreamTransport.ts";

interface LynxRequestInit extends RequestInit {
  lynxExtension?: {
    enableFetchAPIStandardStreaming?: boolean;
  };
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
  const extension = streamingExtension(request.expectStreamingResponse);
  if (Object.keys(extension).length > 0) {
    init.lynxExtension = extension;
  }
  const response = await fetchImpl(request.url, init);
  if (!request.expectStreamingResponse) {
    return stabilizeJsonResponse(response);
  }
  // Keep a usable Fetch body. Do not reroute to GlobalEventEmitter just because
  // lynx-bg has one — that is the native streamingId path, not host-fetch.
  return identifierStreamingResponse(response);
}

/** Lynx-for-Web / desktop identifier `fetch` (browser or PrimJS fetch). */
export const hostFetchTransport: SyncStreamTransport = {
  name: "host-fetch",
  fetch: fetchViaHost,
};
