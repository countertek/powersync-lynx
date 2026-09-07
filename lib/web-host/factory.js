import { decodeCloneable, encodeCloneable } from './cloneable.js';

function hop(NativeModulesCall, method, data, callback) {
  Promise.resolve(NativeModulesCall(method, encodeCloneable(data)))
    .then((result) => {
      callback(decodeCloneable(result));
    })
    .catch((err) => {
      const message =
        err && typeof err === 'object' && err.message != null ? String(err.message) : String(err);
      const envelope = { ok: false, message };
      if (err && typeof err === 'object' && typeof err.code === 'number') {
        envelope.code = err.code;
      }
      callback(envelope);
    });
}

/**
 * lynx-bg Native Module factory. Default export is loaded from nativeModulesMap.
 * Does not import @powersync/web.
 *
 * @param {unknown} _NativeModules
 * @param {(name: string, data: unknown) => unknown} NativeModulesCall
 */
export default function createNativePowerSyncModule(_NativeModules, NativeModulesCall) {
  return {
    open(options, callback) {
      hop(NativeModulesCall, 'open', options, callback);
    },
    close(dbId, callback) {
      hop(NativeModulesCall, 'close', dbId, callback);
    },
    execute(dbId, sql, params, callback) {
      hop(NativeModulesCall, 'execute', { dbId, sql, params }, callback);
    },
    executeBatch(dbId, sql, params, callback) {
      hop(NativeModulesCall, 'executeBatch', { dbId, sql, params }, callback);
    }
  };
}
