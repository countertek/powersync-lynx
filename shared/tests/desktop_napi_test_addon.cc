// Stock Node.js N-API test harness binding NativePowerSyncModule onto isolated
// ps_sql::Engine + SyncHttpEngine instances (no USE_WEAK_SUFFIX_NAPI).
#include "NativePowerSyncBindings.h"
#include "ps_sql.h"
#include "sync_http/sync_http_engine.h"

#include "napi.h"

#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

struct RecordedEvent {
  std::string stream_id;
  std::string event;
  std::string data;
  std::string error;
};

struct TestInstance {
  std::unique_ptr<ps_sql::Engine> sql_engine;
  std::unique_ptr<ps_sync_http::SyncHttpEngine> http_engine;
  std::mutex override_mu;
  std::vector<RecordedEvent> override_events;
};

Napi::Value CreateBoundModule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ps_sql::EngineConfig cfg;
  const char* core_env = std::getenv("POWERSYNC_CORE_PATH");
  if (core_env != nullptr) {
    cfg.core_path = core_env;
  }
  auto* inst = new TestInstance();
  inst->sql_engine = std::make_unique<ps_sql::Engine>(cfg);
  inst->http_engine = std::make_unique<ps_sync_http::SyncHttpEngine>();

  Napi::Object native = Napi::Object::New(env);
  ps_native_module::BindNativePowerSyncModule(
      env, native, *inst->sql_engine, *inst->http_engine);

  Napi::Object handle = Napi::Object::New(env);
  handle.Set("native", native);

  handle.Set(
      "enableSharedOverride",
      Napi::Function::New(
          env,
          [inst](const Napi::CallbackInfo& cb_info) {
            const bool enable = cb_info.Length() > 0 && cb_info[0].ToBoolean();
            if (!enable) {
              inst->http_engine->SetSharedStreamEventSender(nullptr);
              return cb_info.Env().Undefined();
            }
            inst->http_engine->SetSharedStreamEventSender(
                [inst](const ps_sync_http::StreamEvent& ev) {
                  std::lock_guard<std::mutex> lock(inst->override_mu);
                  inst->override_events.push_back(
                      {ev.stream_id, ev.event, ev.data, ev.error});
                });
            return cb_info.Env().Undefined();
          }));

  handle.Set(
      "takeOverrideEvents",
      Napi::Function::New(
          env,
          [inst](const Napi::CallbackInfo& cb_info) {
            Napi::Env e = cb_info.Env();
            std::vector<RecordedEvent> snapshot;
            {
              std::lock_guard<std::mutex> lock(inst->override_mu);
              snapshot.swap(inst->override_events);
            }
            Napi::Array arr = Napi::Array::New(e, snapshot.size());
            for (std::size_t i = 0; i < snapshot.size(); ++i) {
              Napi::Object item = Napi::Object::New(e);
              item.Set("streamId", Napi::String::New(e, snapshot[i].stream_id));
              item.Set("event", Napi::String::New(e, snapshot[i].event));
              item.Set("data", Napi::String::New(e, snapshot[i].data));
              item.Set("error", Napi::String::New(e, snapshot[i].error));
              arr.Set(i, item);
            }
            return arr;
          }));

  handle.Set(
      "shutdown",
      Napi::Function::New(
          env,
          [inst](const Napi::CallbackInfo& cb_info) {
            inst->http_engine->Shutdown();
            inst->http_engine.reset();
            inst->sql_engine.reset();
            delete inst;
            return cb_info.Env().Undefined();
          }));

  return handle;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("createBoundModule",
              Napi::Function::New(env, CreateBoundModule));
  return exports;
}

}  // namespace

NODE_API_MODULE(desktop_napi_test, Init)
