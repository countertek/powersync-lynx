import { type AttachOptions, type NativeModulesCallHandler } from "./page-rpc.js";
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
/**
 * Wire Native Module SQL RPC onto host-page WASQLite for one `<lynx-view>`.
 */
export declare function attach(lynxView: LynxViewHost, options?: AttachOptions): AttachHandle;
export type { AttachOptions };
