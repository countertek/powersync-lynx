import { MODULE_NAME, createOnNativeModulesCall } from './page-rpc.js';

function loadWeb() {
  return import('@powersync/web');
}

/**
 * Wire Native Module SQL RPC onto host-page WASQLite for one `<lynx-view>`.
 *
 * @param {{ nativeModulesMap?: Record<string, string> | null, onNativeModulesCall?: Function | null }} lynxView
 * @param {object} [options]
 * @returns {{ detach(): void }}
 */
export function attach(lynxView, options) {
  if (lynxView == null || typeof lynxView !== 'object') {
    throw new Error('attach requires a <lynx-view> element');
  }

  const factoryUrl = new URL('./factory.js', import.meta.url).href;
  const previousMap = lynxView.nativeModulesMap ?? {};
  lynxView.nativeModulesMap = {
    ...previousMap,
    [MODULE_NAME]: factoryUrl
  };

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
        const next = { ...current };
        delete next[MODULE_NAME];
        if (Object.prototype.hasOwnProperty.call(previousMap, MODULE_NAME)) {
          next[MODULE_NAME] = previousMap[MODULE_NAME];
        }
        lynxView.nativeModulesMap = next;
      }
    }
  };
}
