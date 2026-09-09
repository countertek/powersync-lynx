import type { NativeModulesHost } from "../src/adapter/native.ts";
import type { LynxTextCodecHelper } from "../src/globals.ts";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
}
