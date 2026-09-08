import {
  asCloneableObject,
  decodeCloneable,
  encodeCloneable,
  type Cloneable,
} from "./cloneable.ts";
import { errorCode } from "../values.ts";
import type { NativeWireEnvelope } from "../adapter/native.ts";

type NativeModulesCall = (name: string, data: Cloneable) => Cloneable | Promise<Cloneable>;

interface LynxNativeModulesBag {
  readonly NativePowerSyncModule?: NativePowerSyncFactory;
}
type FactoryCallback = (envelope: NativeWireEnvelope) => void;

interface HopErrorFields {
  message?: string;
  code?: number;
}

function hopMessage(err: Error | HopErrorFields | string): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err instanceof Object && err.message != null) {
    return String(err.message);
  }
  return String(err);
}

function hopCode(err: Error | HopErrorFields | string): number | undefined {
  return err instanceof Object ? errorCode(err) : undefined;
}

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
    .catch((err: Error | HopErrorFields | string) => {
      const envelope: NativeWireEnvelope = { ok: false, message: hopMessage(err) };
      const code = hopCode(err);
      if (code !== undefined) {
        envelope.code = code;
      }
      callback(envelope);
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
 * Does not import @powersync/web.
 */
export default function createNativePowerSyncModule(
  _NativeModules: LynxNativeModulesBag,
  NativeModulesCall: NativeModulesCall,
): NativePowerSyncFactory {
  return {
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
}
