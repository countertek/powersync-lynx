import "../abort-controller.js";
import { AbstractRemote } from "@powersync/shared-internals";
import type { PowerSyncBackendConnector, PowerSyncLogger } from "@powersync/common";
import type { FetchOptions } from "@powersync/shared-internals";
import type { WebSocketSupport, WebSocketSyncStreamPlatform } from "@powersync/shared-internals/websockets";
export interface LynxTextCodecHelper {
    decode(buffer: ArrayBuffer): string;
}
export declare class LynxRemote extends AbstractRemote {
    constructor(connector: PowerSyncBackendConnector, logger: PowerSyncLogger);
    createTextDecoder(): TextDecoder;
    fetch({ resource, request }: FetchOptions): Promise<Response>;
    loadWebSocketSupport(platform: WebSocketSyncStreamPlatform): Promise<WebSocketSupport>;
    getUserAgent(): string;
}
