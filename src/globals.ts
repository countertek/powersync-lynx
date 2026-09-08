import type { NativeModulesHost } from "./adapter/native.ts";
import type { LynxTextCodecHelper } from "./sync/LynxRemote.ts";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
}
