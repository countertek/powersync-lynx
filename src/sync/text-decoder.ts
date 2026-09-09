import { copyToArrayBuffer } from "../values.ts";
import { decodeUtf8, toArrayBuffer, trailingIncompleteUtf8Bytes } from "./transport/bytes.ts";

export function createLynxTextDecoder(): TextDecoder {
  let carry = new Uint8Array(0);
  const decoder = {
    decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
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
      return decodeUtf8(copyToArrayBuffer(complete));
    },
  };
  // SAFETY: Lynx TextCodecHelper.decode is the UTF-8 path; PowerSync only calls decode().
  return decoder as TextDecoder;
}
