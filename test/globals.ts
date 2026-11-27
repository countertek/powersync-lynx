import type {
  LynxRuntime,
  LynxSystemInfo,
  LynxTextCodecHelper,
  NativeModulesHost,
} from "../src/host.ts";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
  var lynx: LynxRuntime | undefined;
  var SystemInfo: LynxSystemInfo | undefined;
}
