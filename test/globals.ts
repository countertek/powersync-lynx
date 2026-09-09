import type { NativeModulesHost } from "../src/adapter/native.ts";
import type { LynxRuntime, LynxSystemInfo, LynxTextCodecHelper } from "../src/globals.ts";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
  var lynx: LynxRuntime | undefined;
  var SystemInfo: LynxSystemInfo | undefined;
}
