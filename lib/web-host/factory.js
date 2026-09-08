import { asCloneableObject, decodeCloneable, encodeCloneable, } from "./cloneable.js";
import { errorCode } from "../values.js";
function hopMessage(err) {
    if (err instanceof Error) {
        return err.message;
    }
    if (err instanceof Object && err.message != null) {
        return String(err.message);
    }
    return String(err);
}
function hopCode(err) {
    return err instanceof Object ? errorCode(err) : undefined;
}
function hop(NativeModulesCall, method, data, callback) {
    Promise.resolve(NativeModulesCall(method, encodeCloneable(data)))
        .then((result) => {
        // SAFETY: NativeModulesCall returns a Cloneable envelope for this module's SQL RPC.
        callback(decodeCloneable(result));
    })
        .catch((err) => {
        const envelope = { ok: false, message: hopMessage(err) };
        const code = hopCode(err);
        if (code !== undefined) {
            envelope.code = code;
        }
        callback(envelope);
    });
}
/**
 * lynx-bg Native Module factory. Default export is loaded from nativeModulesMap.
 * Does not import @powersync/web.
 */
export default function createNativePowerSyncModule(_NativeModules, NativeModulesCall) {
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
