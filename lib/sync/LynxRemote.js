import "../abort-controller.js";
import { AbstractRemote } from "@powersync/shared-internals";
import { copyToArrayBuffer } from "../values.js";
let websockets;
function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
        return input;
    }
    const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return copyToArrayBuffer(bytes);
}
function trailingIncompleteUtf8Bytes(bytes) {
    if (bytes.length === 0) {
        return 0;
    }
    let i = bytes.length - 1;
    let continuation = 0;
    while (i >= 0 && (bytes[i] & 0xc0) === 0x80) {
        continuation++;
        i--;
    }
    if (i < 0) {
        return bytes.length;
    }
    const lead = bytes[i];
    let expected = 0;
    if ((lead & 0x80) === 0) {
        expected = 0;
    }
    else if ((lead & 0xe0) === 0xc0) {
        expected = 1;
    }
    else if ((lead & 0xf0) === 0xe0) {
        expected = 2;
    }
    else if ((lead & 0xf8) === 0xf0) {
        expected = 3;
    }
    else {
        return 0;
    }
    const have = continuation;
    if (have < expected) {
        return have + 1;
    }
    return 0;
}
function createLynxTextDecoder() {
    let carry = new Uint8Array(0);
    const decoder = {
        decode(input, options) {
            const helper = globalThis.TextCodecHelper;
            if (helper == null) {
                throw new Error("TextCodecHelper is not registered");
            }
            const stream = options?.stream === true;
            const incoming = input == null ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(input));
            const combined = new Uint8Array(carry.length + incoming.length);
            combined.set(carry, 0);
            combined.set(incoming, carry.length);
            const hold = stream ? trailingIncompleteUtf8Bytes(combined) : 0;
            const complete = combined.subarray(0, combined.length - hold);
            carry = combined.subarray(combined.length - hold);
            if (complete.length === 0) {
                return "";
            }
            return helper.decode(copyToArrayBuffer(complete));
        },
    };
    // SAFETY: Lynx TextCodecHelper.decode is the UTF-8 path; PowerSync only calls decode().
    return decoder;
}
export class LynxRemote extends AbstractRemote {
    constructor(connector, logger) {
        super(connector, logger);
    }
    createTextDecoder() {
        return createLynxTextDecoder();
    }
    fetch({ resource, request }) {
        return globalThis.fetch(resource, request);
    }
    async loadWebSocketSupport(platform) {
        if (!websockets) {
            const module = await import("@powersync/shared-internals/websockets");
            websockets = new module.WebSocketSupport(platform);
        }
        return websockets;
    }
    getUserAgent() {
        return [super.getUserAgent(), "powersync-lynx"].join(" ");
    }
}
