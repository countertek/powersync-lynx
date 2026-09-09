import type { NativeModulesHost } from "./adapter/native.ts";
import type { LynxTextCodecHelper } from "./sync/LynxRemote.ts";

export {};

declare global {
  var NativeModules: NativeModulesHost | undefined;
  var TextCodecHelper: LynxTextCodecHelper | undefined;
  /** Lynx BTS global — prefer bare `lynx` so the bundler keeps the runtime binding. */
  var lynx:
    | {
        getJSModule?: (name: string) => unknown;
        getApp?: () => { GlobalEventEmitter?: unknown };
        GlobalEventEmitter?: unknown;
      }
    | undefined;
  var SystemInfo: { platform?: string } | undefined;
}
