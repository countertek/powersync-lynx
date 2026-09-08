import { type Cloneable } from "./cloneable.js";
import type { NativeWireEnvelope } from "../adapter/native.js";
type NativeModulesCall = (name: string, data: Cloneable) => Cloneable | Promise<Cloneable>;
interface LynxNativeModulesBag {
    readonly NativePowerSyncModule?: NativePowerSyncFactory;
}
type FactoryCallback = (envelope: NativeWireEnvelope) => void;
export interface NativePowerSyncFactory {
    open(options: Cloneable, callback: FactoryCallback): void;
    close(dbId: Cloneable, callback: FactoryCallback): void;
    execute(dbId: Cloneable, sql: Cloneable, params: Cloneable, callback: FactoryCallback): void;
    executeBatch(dbId: Cloneable, sql: Cloneable, params: Cloneable, callback: FactoryCallback): void;
}
/**
 * lynx-bg Native Module factory. Default export is loaded from nativeModulesMap.
 * Does not import @powersync/web.
 */
export default function createNativePowerSyncModule(_NativeModules: LynxNativeModulesBag, NativeModulesCall: NativeModulesCall): NativePowerSyncFactory;
export {};
