#ifndef POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_
#define POWERSYNC_LYNX_NATIVE_POWERSYNC_MODULE_H_

#include <lynx/registration.h>

// CMake LynxView fallback: LynxEnv.RegisterNativeModule("NativePowerSyncModule",
// CreateNativePowerSyncModule, nullptr). Lynxtron Autolink uses
// LYNX_REGISTER_NATIVE_MODULE in NativePowerSyncModule.cc instead.
napi_value CreateNativePowerSyncModule(::lynx::registration::LynxNapiEnv env,
                                       ::lynx::registration::LynxNapiValue exports,
                                       const char* module_name, void* opaque);

#endif
