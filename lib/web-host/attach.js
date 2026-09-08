import { MODULE_NAME, createOnNativeModulesCall, } from "./page-rpc.js";
function asMutableMap(map) {
    // SAFETY: Lynx nativeModulesMap is a string-keyed module URL table that attach merges.
    return map;
}
/**
 * Wire Native Module SQL RPC onto host-page WASQLite for one `<lynx-view>`.
 */
export function attach(lynxView, options) {
    if (lynxView == null || !(lynxView instanceof Object)) {
        throw new Error("attach requires a <lynx-view> element");
    }
    const factoryUrl = new URL("./factory.js", import.meta.url).href;
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
async function loadWeb() {
    return import("@powersync/web");
}
