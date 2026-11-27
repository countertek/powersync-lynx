#ifndef POWERSYNC_LYNX_NATIVE_POWERSYNC_BINDINGS_H_
#define POWERSYNC_LYNX_NATIVE_POWERSYNC_BINDINGS_H_

#include "NativePowerSyncModule.h"

#if defined(USE_WEAK_SUFFIX_NAPI)
#if defined(__has_include)
#if __has_include(<third_party/weak-node-api/headers/weak_napi_defines.h>)
#include <third_party/weak-node-api/headers/weak_napi_defines.h>
#elif __has_include(<weak_napi_defines.h>)
#include <weak_napi_defines.h>
#endif
#endif
#endif

namespace ps_sql {
class Engine;
}  // namespace ps_sql

namespace ps_sync_http {
class SyncHttpEngine;
}  // namespace ps_sync_http

namespace ps_native_module {

// Internal injectable seams for desktop SQL RPC and sync-HTTP N-API binding.
// Production calls BindNativePowerSyncModule with process singletons; Node N-API
// tests inject isolated Engine + SyncHttpEngine instances.
void BindNativePowerSyncSql(napi_env env, napi_value exports,
                            ps_sql::Engine& engine);

void BindNativeSyncHttp(napi_env env, napi_value exports,
                        ps_sync_http::SyncHttpEngine& engine);

void BindNativePowerSyncModule(napi_env env, napi_value exports,
                               ps_sql::Engine& sql_engine,
                               ps_sync_http::SyncHttpEngine& http_engine);

}  // namespace ps_native_module

#if defined(USE_WEAK_SUFFIX_NAPI)
#if defined(__has_include)
#if __has_include(<third_party/weak-node-api/headers/weak_napi_undefs.h>)
#include <third_party/weak-node-api/headers/weak_napi_undefs.h>
#elif __has_include(<weak_napi_undefs.h>)
#include <weak_napi_undefs.h>
#endif
#endif
#endif

#endif  // POWERSYNC_LYNX_NATIVE_POWERSYNC_BINDINGS_H_
