#ifndef POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_
#define POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_

// CMake LynxView fallback: LynxEnv.RegisterNativeModule("NativePowerSyncModule",
// CreateNativePowerSyncModule, nullptr). Signature matches napi_module_creator
// without including <lynx/registration.h>. Lynxtron Autolink uses
// LYNX_REGISTER_NATIVE_MODULE in NativePowerSyncModule.cc instead.
#if defined(__has_include)
#if __has_include(<node_api.h>)
#include <node_api.h>
#endif
#endif

#ifndef NAPI_VERSION
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
#endif

napi_value CreateNativePowerSyncModule(napi_env env, napi_value exports,
                                       const char* module_name, void* opaque);

#endif
