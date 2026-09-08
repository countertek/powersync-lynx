import type { NativeModulesHost } from "./adapter/native.js";
import type { LynxTextCodecHelper } from "./sync/LynxRemote.js";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
}
