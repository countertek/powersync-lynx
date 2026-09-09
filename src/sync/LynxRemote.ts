import { AbstractRemote } from "@powersync/shared-internals";
import type { PowerSyncBackendConnector, PowerSyncLogger } from "@powersync/common";
import { LogLevels } from "@powersync/common";
import type { FetchOptions } from "@powersync/shared-internals";
import type {
  WebSocketSupport,
  WebSocketSyncStreamPlatform,
} from "@powersync/shared-internals/websockets";
import { createLynxTextDecoder } from "./text-decoder.ts";
import {
  pickSyncStreamTransport,
  syncStreamRequestFromFetch,
} from "./transport/SyncStreamTransport.ts";

export type { LynxTextCodecHelper } from "../globals.ts";
export type {
  SyncStreamRequest,
  SyncStreamTransport,
  SyncStreamTransportName,
} from "./transport/SyncStreamTransport.ts";

let websockets: WebSocketSupport | undefined;

/**
 * Thin AbstractRemote adapter: pick a {@link SyncStreamTransport} and override
 * PrimJS TextDecoder. Stream quirks live in `src/sync/transport/`.
 */
export class LynxRemote extends AbstractRemote {
  constructor(connector: PowerSyncBackendConnector, logger: PowerSyncLogger) {
    super(connector, logger);
  }

  createTextDecoder(): TextDecoder {
    return createLynxTextDecoder();
  }

  async fetch(options: FetchOptions): Promise<Response> {
    const request = syncStreamRequestFromFetch(options);
    const transport = pickSyncStreamTransport(request);
    if (request.expectStreamingResponse) {
      this.logger.log({
        level: LogLevels.debug,
        message: `powersync-lynx /sync/stream via ${transport.name}`,
      });
    }
    return transport.fetch(request);
  }

  async loadWebSocketSupport(platform: WebSocketSyncStreamPlatform): Promise<WebSocketSupport> {
    if (!websockets) {
      const module = await import("@powersync/shared-internals/websockets");
      websockets = new module.WebSocketSupport(platform);
    }
    return websockets;
  }

  getUserAgent(): string {
    return [super.getUserAgent(), "powersync-lynx"].join(" ");
  }
}
