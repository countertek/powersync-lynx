#ifndef POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_
#define POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_

// Native CMake LynxView registration:
//   lynx::pub::LynxEnv::GetInstance().RegisterNativeModule(
//       "NativePowerSyncModule", CreateNativePowerSyncModule, nullptr);
// Signature matches napi_module_creator without including <lynx/registration.h>.
// Lynxtron Autolink uses LYNX_REGISTER_NATIVE_MODULE in NativePowerSyncModule.cc.
#if defined(__has_include)
#if __has_include(<capi/lynx_native_module_capi.h>)
#include <capi/lynx_native_module_capi.h>
#elif __has_include(<third_party/weak-node-api/headers/node_api.h>)
#include <third_party/weak-node-api/headers/node_api.h>
#elif __has_include(<node_api.h>)
#include <node_api.h>
#endif
#endif

#if defined(USE_WEAK_SUFFIX_NAPI)
#if defined(__has_include)
#if __has_include(<third_party/weak-node-api/headers/weak_napi_defines.h>)
#include <third_party/weak-node-api/headers/weak_napi_defines.h>
#elif __has_include(<weak_napi_defines.h>)
#include <weak_napi_defines.h>
#endif
#endif
#endif

#ifndef NAPI_VERSION
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
#endif

#ifdef __cplusplus
extern "C" {
#endif

napi_value CreateNativePowerSyncModule(napi_env env, napi_value exports,
                                       const char* module_name, void* opaque);

#ifdef __cplusplus
}
#endif

#if defined(USE_WEAK_SUFFIX_NAPI)
#if defined(__has_include)
#if __has_include(<third_party/weak-node-api/headers/weak_napi_undefs.h>)
#include <third_party/weak-node-api/headers/weak_napi_undefs.h>
#elif __has_include(<weak_napi_undefs.h>)
#include <weak_napi_undefs.h>
#endif
#endif
#endif

#endif
