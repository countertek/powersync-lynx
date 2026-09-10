import {
  MODULE_NAME,
  createOnNativeModulesCall,
  type AttachOptions,
  type NativeModulesCallHandler,
} from "./page-rpc.ts";

export interface NativeModulesMap {
  NativePowerSyncModule?: string;
}

export interface LynxViewHost {
  nativeModulesMap?: NativeModulesMap | null;
  onNativeModulesCall?: NativeModulesCallHandler | null;
}

export interface AttachHandle {
  detach(): void;
}

function asMutableMap(map: NativeModulesMap): { [key: string]: string } {
  // SAFETY: Lynx nativeModulesMap is a string-keyed module URL table that attach merges.
  return map as { [key: string]: string };
}

/**
 * Wire Native Module SQL RPC onto host-page WASQLite for one `<lynx-view>`.
 */
export function attach(lynxView: LynxViewHost, options?: AttachOptions): AttachHandle {
  if (lynxView == null || !(lynxView instanceof Object)) {
    throw new Error("attach requires a <lynx-view> element");
  }

  const factoryUrl = new URL("../../dist/web-host/factory.js", import.meta.url).href;
  const previousMap = lynxView.nativeModulesMap ?? {};
  const nextMap = asMutableMap({ ...previousMap });
  nextMap[MODULE_NAME] = factoryUrl;
  lynxView.nativeModulesMap = nextMap;

  const previousCall = lynxView.onNativeModulesCall;
  const wrapped = createOnNativeModulesCall(previousCall, options, loadWeb);
  lynxView.onNativeModulesCall = wrapped;

  return {
    detach() {
      if (lynxView.onNativeModulesCall !== wrapped) {
        return;
      }
      lynxView.onNativeModulesCall = previousCall;
      const current = lynxView.nativeModulesMap;
      if (current && current[MODULE_NAME] === factoryUrl) {
        const restored = asMutableMap({ ...current });
        delete restored[MODULE_NAME];
        if (Object.prototype.hasOwnProperty.call(previousMap, MODULE_NAME)) {
          restored[MODULE_NAME] = previousMap[MODULE_NAME] ?? factoryUrl;
        }
        lynxView.nativeModulesMap = restored;
      }
    },
  };
}

async function loadWeb(): Promise<import("./page-rpc.ts").PowerSyncWebModule> {
  // Native installs omit the optional @powersync/web peer (TS2307).
  // Web installs resolve it, so @ts-expect-error would be unused.
  // @ts-ignore TS2307
  const loaded = await import("@powersync/web");
  // SAFETY: Lynx-for-Web loads @powersync/web as WASQLiteOpenFactory + optional createConsoleLogger.
  return loaded as import("./page-rpc.ts").PowerSyncWebModule;
}

export type { AttachOptions };
