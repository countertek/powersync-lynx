import type { NativeModulesHost } from "../lib/adapter/native.js";
import type { LynxTextCodecHelper } from "../lib/sync/LynxRemote.js";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
}
