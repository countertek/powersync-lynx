import {
  asCloneableObject,
  decodeCloneable,
  encodeCloneable,
  type Cloneable,
} from "./cloneable.ts";
import { failEnvelopeFromError } from "../values.ts";
import type { NativeWireEnvelope } from "../adapter/native.ts";

type NativeModulesCall = (name: string, data: Cloneable) => Cloneable | Promise<Cloneable>;

interface LynxNativeModulesBag {
  NativePowerSyncModule?: NativePowerSyncFactory;
}

type FactoryCallback = (envelope: NativeWireEnvelope) => void;

function hop(
  NativeModulesCall: NativeModulesCall,
  method: string,
  data: Cloneable,
  callback: FactoryCallback,
): void {
  Promise.resolve(NativeModulesCall(method, encodeCloneable(data)))
    .then((result) => {
      // SAFETY: NativeModulesCall returns a Cloneable envelope for this module's SQL RPC.
      callback(decodeCloneable(result) as NativeWireEnvelope);
    })
    .catch((cause: unknown) => {
      callback(failEnvelopeFromError(cause));
    });
}

export interface NativePowerSyncFactory {
  open(options: Cloneable, callback: FactoryCallback): void;
  close(dbId: Cloneable, callback: FactoryCallback): void;
  execute(dbId: Cloneable, sql: Cloneable, params: Cloneable, callback: FactoryCallback): void;
  executeBatch(dbId: Cloneable, sql: Cloneable, params: Cloneable, callback: FactoryCallback): void;
}

/**
 * lynx-bg Native Module factory. Default export is loaded from nativeModulesMap.
 * Assigns methods onto the NativeModules bag and the worker global because
 * lynx-bg lookup is NativeModules.NativePowerSyncModule, not the return value.
 * Does not import @powersync/web.
 */
export default function createNativePowerSyncModule(
  nativeModules: LynxNativeModulesBag,
  NativeModulesCall: NativeModulesCall,
): NativePowerSyncFactory {
  const methods: NativePowerSyncFactory = {
    open(options, callback) {
      hop(NativeModulesCall, "open", options, callback);
    },
    close(dbId, callback) {
      hop(NativeModulesCall, "close", dbId, callback);
    },
    execute(dbId, sql, params, callback) {
      hop(NativeModulesCall, "execute", asCloneableObject({ dbId, sql, params }), callback);
    },
    executeBatch(dbId, sql, params, callback) {
      hop(NativeModulesCall, "executeBatch", asCloneableObject({ dbId, sql, params }), callback);
    },
  };
  nativeModules.NativePowerSyncModule = methods;
  // lynx-bg looks up NativeModules.NativePowerSyncModule on the worker global.
  Object.assign(globalThis, { NativeModules: nativeModules });
  return methods;
}
