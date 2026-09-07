#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_defines.h"
#endif

#include <node_api.h>
#include "napi.h"

#ifndef EXTERN_C_START
#ifdef __cplusplus
#define EXTERN_C_START extern "C" {
#define EXTERN_C_END }
#else
#define EXTERN_C_START
#define EXTERN_C_END
#endif
#endif

#if defined(_WIN32)
#define LYNX_NAPI_MODULE_EXPORT __declspec(dllexport)
#define LYNX_NAPI_C_CTOR(fn)               \
  extern "C" void fn(void);                \
  namespace {                              \
  struct fn##_runner {                     \
    fn##_runner() { fn(); }                \
  };                                       \
  static fn##_runner fn##_runner_instance; \
  }                                        \
  extern "C" void fn(void)
#else
#define LYNX_NAPI_MODULE_EXPORT __attribute__((visibility("default")))
#define LYNX_NAPI_C_CTOR(fn)                             \
  extern "C" void fn(void) __attribute__((constructor)); \
  extern "C" void fn(void)
#endif

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return exports;
}

static napi_value RegisterNodeApiModule(napi_env env, napi_value exports) {
  return Napi::RegisterModule(env, exports, Init);
}

EXTERN_C_START
LYNX_NAPI_MODULE_EXPORT int32_t NAPI_CDECL
NODE_API_MODULE_GET_API_VERSION(void) {
  return NAPI_VERSION;
}

LYNX_NAPI_MODULE_EXPORT napi_value NAPI_CDECL
NAPI_MODULE_INITIALIZER(napi_env env, napi_value exports) {
  return RegisterNodeApiModule(env, exports);
}
EXTERN_C_END

static napi_module _napi_module_powersync_lynx = {
    NAPI_MODULE_VERSION, 0, __FILE__, RegisterNodeApiModule, "powersync-lynx",
    NULL, {NULL}};

LYNX_NAPI_C_CTOR(_napi_register_xx_powersync_lynx) {
  napi_module_register(&_napi_module_powersync_lynx);
}

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_undefs.h"
#endif
