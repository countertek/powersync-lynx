#if !defined(POWERSYNC_NO_STATIC_REGISTRATION) && defined(__has_include)
#if __has_include(<lynx/registration.h>)
#define POWERSYNC_USE_LYNX_REGISTRATION 1
#include <lynx/registration.h>
#endif
#endif

#include "NativePowerSyncModule.h"
#include "core_path.h"
#include "db_location.h"
#include "ps_sql.h"
#include "sync_http/sync_http_engine.h"
#include "sync_http_policy.h"

#include "napi.h"

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_defines.h"
#endif

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include "win_utf8.h"
#else
#include <dlfcn.h>
#include <sys/stat.h>
#endif

namespace {

using ps_sql::BindValue;
using ps_sql::Cell;
using ps_sql::CellKind;
using ps_sql::Engine;
using ps_sql::EngineConfig;
using ps_sql::Envelope;
using ps_sql::OpenOptions;

EngineConfig MakeConfig();

Engine& GetEngine() {
  // Intentionally heap-allocated (matching iOS/Android) so worker threads never
  // race static destruction at process exit.
  static Engine* engine = new Engine(MakeConfig());
  return *engine;
}

std::string ModuleDirectory() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&ModuleDirectory),
                          &module)) {
    return ".";
  }
  const std::string full = ps_sql::GetModuleFilePathUtf8(module);
  if (full.empty()) {
    return ".";
  }
  const auto slash = full.find_last_of("\\/");
  return slash == std::string::npos ? std::string(".") : full.substr(0, slash);
#else
  Dl_info info;
  if (dladdr(reinterpret_cast<const void*>(&ModuleDirectory), &info) == 0 ||
      info.dli_fname == nullptr) {
    return ".";
  }
  std::string full(info.dli_fname);
  const auto slash = full.find_last_of('/');
  return slash == std::string::npos ? std::string(".") : full.substr(0, slash);
#endif
}

std::string CoreFileName() {
#if defined(_WIN32)
#if defined(_M_ARM64) || defined(__aarch64__)
  return "powersync_aarch64.dll";
#elif defined(_M_IX86) || defined(__i386__)
  return "powersync_x86.dll";
#else
  return "powersync_x64.dll";
#endif
#elif defined(__APPLE__)
#if defined(__aarch64__)
  return "libpowersync_aarch64.macos.dylib";
#else
  return "libpowersync_x64.macos.dylib";
#endif
#else
  return "libpowersync.so";
#endif
}

std::string ReadCorePathEnv() {
#if defined(_WIN32)
  return ps_sql::ReadEnvVarUtf8(L"POWERSYNC_CORE_PATH");
#else
  const char* value = std::getenv("POWERSYNC_CORE_PATH");
  return value != nullptr ? std::string(value) : std::string();
#endif
}

bool FileExists(const std::string& path) {
#if defined(_WIN32)
  const std::wstring wide = ps_sql::Utf8ToWide(path);
  if (wide.empty()) {
    return false;
  }
  const DWORD attrs = GetFileAttributesW(wide.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES &&
         (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
#else
  struct stat st;
  return stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
#endif
}

EngineConfig MakeConfig() {
  EngineConfig config;
  ps_sql::CorePathOptions path_options;
#if defined(_WIN32)
  config.core_load = ps_sql::CoreLoad::kLoadExtension;
  path_options.platform = ps_sql::CorePlatform::kWindows;
#elif defined(__APPLE__)
  config.core_load = ps_sql::CoreLoad::kAutoExtension;
  path_options.platform = ps_sql::CorePlatform::kMacOS;
#else
  config.core_load = ps_sql::CoreLoad::kAutoExtension;
  path_options.platform = ps_sql::CorePlatform::kLinux;
#endif
  path_options.env_core_path = ReadCorePathEnv();
  path_options.module_dir = ModuleDirectory();
  path_options.core_filename = CoreFileName();
  path_options.file_exists = FileExists;
  config.core_path = ps_sql::ResolveCorePath(path_options);
  return config;
}

bool IsSafeInteger(double value) {
  if (!std::isfinite(value) || value != std::nearbyint(value)) {
    return false;
  }
  return value >= -9007199254740991.0 && value <= 9007199254740991.0;
}

Napi::Value CellToJs(Napi::Env env, const Cell& cell) {
  switch (cell.kind) {
    case CellKind::kNull:
      return env.Null();
    case CellKind::kInteger:
      if (cell.integer_as_bigint) {
        return Napi::BigInt::New(env, cell.i);
      }
      return Napi::Number::New(env, static_cast<double>(cell.i));
    case CellKind::kFloat:
      return Napi::Number::New(env, cell.f);
    case CellKind::kText:
      return Napi::String::New(env, cell.text);
    case CellKind::kBlob: {
      Napi::ArrayBuffer buffer =
          Napi::ArrayBuffer::New(env, cell.blob.size());
      if (!cell.blob.empty()) {
        std::memcpy(buffer.Data(), cell.blob.data(), cell.blob.size());
      }
      return buffer;
    }
  }
  return env.Null();
}

Napi::Object EnvelopeToJs(Napi::Env env, const Envelope& envelope) {
  Napi::Object object = Napi::Object::New(env);
  object.Set("ok", Napi::Boolean::New(env, envelope.ok));
  if (!envelope.ok) {
    object.Set("message", Napi::String::New(env, envelope.message));
    if (envelope.code.has_value()) {
      object.Set("code", Napi::Number::New(env, *envelope.code));
    }
    return object;
  }
  if (!envelope.db_id.empty()) {
    object.Set("dbId", Napi::String::New(env, envelope.db_id));
  }
  object.Set("insertId",
             Napi::Number::New(env, static_cast<double>(envelope.insert_id)));
  object.Set("rowsAffected", Napi::Number::New(
                                 env, static_cast<double>(envelope.rows_affected)));
  Napi::Array names = Napi::Array::New(env, envelope.column_names.size());
  for (std::size_t i = 0; i < envelope.column_names.size(); ++i) {
    names.Set(i, Napi::String::New(env, envelope.column_names[i]));
  }
  object.Set("columnNames", names);
  Napi::Array rows = Napi::Array::New(env, envelope.raw_rows.size());
  for (std::size_t r = 0; r < envelope.raw_rows.size(); ++r) {
    const auto& row = envelope.raw_rows[r];
    Napi::Array js_row = Napi::Array::New(env, row.size());
    for (std::size_t c = 0; c < row.size(); ++c) {
      js_row.Set(c, CellToJs(env, row[c]));
    }
    rows.Set(r, js_row);
  }
  object.Set("rawRows", rows);
  return object;
}

void InvokeJs(Napi::ThreadSafeFunction tsfn, Envelope envelope) {
  auto* copy = new Envelope(std::move(envelope));
  const napi_status status = tsfn.BlockingCall(
      copy, [](Napi::Env env, Napi::Function js_callback, Envelope* data) {
        std::unique_ptr<Envelope> owned(data);
        js_callback.Call({EnvelopeToJs(env, *owned)});
      });
  tsfn.Release();
  if (status != napi_ok) {
    delete copy;
  }
}

std::optional<BindValue> ParseBind(const Napi::Value& value, std::string* error) {
  BindValue bind;
  if (value.IsNull() || value.IsUndefined()) {
    bind.kind = CellKind::kNull;
    return bind;
  }
  if (value.IsBigInt()) {
    bool lossless = false;
    bind.kind = CellKind::kInteger;
    bind.i = value.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless) {
      *error = "bigint bind value does not fit in int64";
      return std::nullopt;
    }
    return bind;
  }
  if (value.IsNumber()) {
    const double number = value.As<Napi::Number>().DoubleValue();
    if (IsSafeInteger(number) &&
        number >= static_cast<double>(std::numeric_limits<std::int64_t>::min()) &&
        number <= static_cast<double>(std::numeric_limits<std::int64_t>::max())) {
      bind.kind = CellKind::kInteger;
      bind.i = static_cast<std::int64_t>(number);
    } else {
      bind.kind = CellKind::kFloat;
      bind.f = number;
    }
    return bind;
  }
  if (value.IsString()) {
    bind.kind = CellKind::kText;
    bind.text = value.As<Napi::String>().Utf8Value();
    return bind;
  }
  if (value.IsArrayBuffer()) {
    Napi::ArrayBuffer buffer = value.As<Napi::ArrayBuffer>();
    bind.kind = CellKind::kBlob;
    const auto* data = static_cast<const std::uint8_t*>(buffer.Data());
    const std::size_t nbytes = buffer.ByteLength();
    if (data != nullptr && nbytes > 0) {
      bind.blob.assign(data, data + nbytes);
    }
    return bind;
  }
  if (value.IsObject()) {
    Napi::Object object = value.As<Napi::Object>();
    if (object.Get("__psBig").ToBoolean()) {
      Napi::Value encoded = object.Get("v");
      if (!encoded.IsString()) {
        *error = "invalid tagged bigint";
        return std::nullopt;
      }
      const std::string digits = encoded.As<Napi::String>().Utf8Value();
      try {
        bind.kind = CellKind::kInteger;
        bind.i = std::stoll(digits);
        return bind;
      } catch (...) {
        *error = "invalid tagged bigint";
        return std::nullopt;
      }
    }
  }
  *error = "unsupported bind value";
  return std::nullopt;
}

std::optional<std::vector<BindValue>> ParseParams(const Napi::Value& value,
                                                  std::string* error) {
  std::vector<BindValue> params;
  if (value.IsNull() || value.IsUndefined()) {
    return params;
  }
  if (!value.IsArray()) {
    *error = "params must be an array";
    return std::nullopt;
  }
  Napi::Array array = value.As<Napi::Array>();
  params.reserve(array.Length());
  for (std::uint32_t i = 0; i < array.Length(); ++i) {
    auto parsed = ParseBind(array.Get(i), error);
    if (!parsed.has_value()) {
      return std::nullopt;
    }
    params.push_back(std::move(*parsed));
  }
  return params;
}

std::optional<std::vector<std::vector<BindValue>>> ParseBatchParams(
    const Napi::Value& value, std::string* error) {
  std::vector<std::vector<BindValue>> rows;
  if (value.IsNull() || value.IsUndefined()) {
    return rows;
  }
  if (!value.IsArray()) {
    *error = "params must be an array of parameter rows";
    return std::nullopt;
  }
  Napi::Array array = value.As<Napi::Array>();
  rows.reserve(array.Length());
  for (std::uint32_t i = 0; i < array.Length(); ++i) {
    auto parsed = ParseParams(array.Get(i), error);
    if (!parsed.has_value()) {
      return std::nullopt;
    }
    rows.push_back(std::move(*parsed));
  }
  return rows;
}

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsFunction()) {
    return env.Undefined();
  }
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "NativePowerSyncModule.open", 0, 1);
  if (!info[0].IsObject()) {
    InvokeJs(tsfn, ps_sql::fail("open expects an options object"));
    return env.Undefined();
  }
  Napi::Object options = info[0].As<Napi::Object>();
  OpenOptions open_options;
  if (!options.Has("dbFilename") || !options.Get("dbFilename").IsString()) {
    InvokeJs(tsfn, ps_sql::fail("dbFilename is required"));
    return env.Undefined();
  }
  open_options.db_filename = options.Get("dbFilename").As<Napi::String>();
  if (options.Has("dbLocation") && !options.Get("dbLocation").IsUndefined() &&
      !options.Get("dbLocation").IsNull()) {
    if (!options.Get("dbLocation").IsString()) {
      InvokeJs(tsfn, ps_sql::fail("dbLocation must be a string"));
      return env.Undefined();
    }
    open_options.db_location = options.Get("dbLocation").As<Napi::String>();
  }
  if (options.Has("readOnly") && options.Get("readOnly").IsBoolean()) {
    open_options.read_only = options.Get("readOnly").As<Napi::Boolean>();
  }
  if (!open_options.db_location.has_value() &&
      ps_sql::NeedsDefaultDbLocation(open_options.db_filename,
                                     ps_sql::CurrentDbLocationPlatform())) {
    std::string dir_error;
    std::string default_dir =
        ps_sql::ResolveAndCreateDefaultDbLocation(&dir_error);
    if (default_dir.empty()) {
      InvokeJs(tsfn, ps_sql::fail(dir_error.empty()
                                      ? "failed to resolve default dbLocation"
                                      : dir_error));
      return env.Undefined();
    }
    open_options.db_location = std::move(default_dir);
  }
  GetEngine().open(std::move(open_options),
                   [tsfn](Envelope envelope) { InvokeJs(tsfn, std::move(envelope)); });
  return env.Undefined();
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsFunction()) {
    return env.Undefined();
  }
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "NativePowerSyncModule.close", 0, 1);
  if (!info[0].IsString()) {
    InvokeJs(tsfn, ps_sql::fail("close expects a dbId string"));
    return env.Undefined();
  }
  GetEngine().close(info[0].As<Napi::String>().Utf8Value(),
                    [tsfn](Envelope envelope) { InvokeJs(tsfn, std::move(envelope)); });
  return env.Undefined();
}

Napi::Value Execute(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[3].IsFunction()) {
    return env.Undefined();
  }
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[3].As<Napi::Function>(), "NativePowerSyncModule.execute", 0, 1);
  if (!info[0].IsString() || !info[1].IsString()) {
    InvokeJs(tsfn, ps_sql::fail("execute expects dbId, sql, params"));
    return env.Undefined();
  }
  std::string error;
  auto params = ParseParams(info[2], &error);
  if (!params.has_value()) {
    InvokeJs(tsfn, ps_sql::fail(error));
    return env.Undefined();
  }
  GetEngine().execute(info[0].As<Napi::String>().Utf8Value(),
                      info[1].As<Napi::String>().Utf8Value(),
                      std::move(*params),
                      [tsfn](Envelope envelope) { InvokeJs(tsfn, std::move(envelope)); });
  return env.Undefined();
}

Napi::Value ExecuteBatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[3].IsFunction()) {
    return env.Undefined();
  }
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env, info[3].As<Napi::Function>(), "NativePowerSyncModule.executeBatch", 0,
      1);
  if (!info[0].IsString() || !info[1].IsString()) {
    InvokeJs(tsfn, ps_sql::fail("executeBatch expects dbId, sql, params"));
    return env.Undefined();
  }
  std::string error;
  auto params = ParseBatchParams(info[2], &error);
  if (!params.has_value()) {
    InvokeJs(tsfn, ps_sql::fail(error));
    return env.Undefined();
  }
  GetEngine().execute_batch(
      info[0].As<Napi::String>().Utf8Value(),
      info[1].As<Napi::String>().Utf8Value(), std::move(*params),
      [tsfn](Envelope envelope) { InvokeJs(tsfn, std::move(envelope)); });
  return env.Undefined();
}

Napi::Object HttpEnvelopeToJs(
    Napi::Env env, const ps_sync_http::HttpResponseEnvelope& envelope) {
  Napi::Object object = Napi::Object::New(env);
  object.Set("ok", Napi::Boolean::New(env, envelope.ok));
  object.Set("status", Napi::Number::New(env, envelope.status));
  object.Set("statusText", Napi::String::New(env, envelope.status_text));
  object.Set("body", Napi::String::New(env, envelope.body));
  object.Set("idleComplete", Napi::Boolean::New(env, envelope.idle_complete));
  if (!envelope.content_type.empty()) {
    object.Set("contentType", Napi::String::New(env, envelope.content_type));
  }
  if (!envelope.streaming_id.empty()) {
    object.Set("streamingId", Napi::String::New(env, envelope.streaming_id));
  }
  if (envelope.has_body_base64) {
    object.Set("bodyBase64", Napi::String::New(env, envelope.body_base64));
  }
  if (!envelope.ok || !envelope.message.empty()) {
    object.Set("message", Napi::String::New(env, envelope.message));
  }
  return object;
}

class OneShotHttpCallback {
 public:
  explicit OneShotHttpCallback(Napi::ThreadSafeFunction tsfn)
      : tsfn_(std::move(tsfn)) {}

  ~OneShotHttpCallback() {
    if (!invoked_.test_and_set()) {
      tsfn_.Release();
    }
  }

  void Invoke(ps_sync_http::HttpResponseEnvelope envelope) {
    if (invoked_.test_and_set()) {
      return;
    }
    auto* copy = new ps_sync_http::HttpResponseEnvelope(std::move(envelope));
    const napi_status status = tsfn_.NonBlockingCall(
        copy, [](Napi::Env env, Napi::Function js_callback,
                 ps_sync_http::HttpResponseEnvelope* data) {
          std::unique_ptr<ps_sync_http::HttpResponseEnvelope> owned(data);
          try {
            js_callback.Call({HttpEnvelopeToJs(env, *owned)});
          } catch (...) {
          }
        });
    tsfn_.Release();
    if (status != napi_ok) {
      delete copy;
    }
  }

 private:
  Napi::ThreadSafeFunction tsfn_;
  std::atomic_flag invoked_ = ATOMIC_FLAG_INIT;
};

struct ResolvedEmitter {
  Napi::Object emitter;
  Napi::Function fn;
  bool is_trigger = false;
};

std::optional<ResolvedEmitter> ResolveGlobalEventEmitter(Napi::Env env) {
  auto extract = [](const Napi::Value& candidate)
      -> std::optional<ResolvedEmitter> {
    if (!candidate.IsObject()) {
      return std::nullopt;
    }
    Napi::Object obj = candidate.As<Napi::Object>();
    // Prefer Lynx GlobalEventEmitter.trigger(name, payload), which invokes
    // listener.call(ctx, payload). Fall back to emit(name, [payload]), which
    // invokes listener.apply(ctx, argsArray) in lynx_core.js.
    Napi::Value trigger_val = obj.Get("trigger");
    if (trigger_val.IsFunction()) {
      return ResolvedEmitter{obj, trigger_val.As<Napi::Function>(), true};
    }
    Napi::Value emit_val = obj.Get("emit");
    if (emit_val.IsFunction()) {
      return ResolvedEmitter{obj, emit_val.As<Napi::Function>(), false};
    }
    return std::nullopt;
  };

  try {
    Napi::Object global = env.Global();
    if (auto found = extract(global.Get("__psLynxGlobalEventEmitter"))) {
      return found;
    }
    Napi::Value lynx_val = global.Get("lynx");
    if (lynx_val.IsObject()) {
      Napi::Object lynx_obj = lynx_val.As<Napi::Object>();
      Napi::Value get_js_module = lynx_obj.Get("getJSModule");
      if (get_js_module.IsFunction()) {
        try {
          Napi::Value mod = get_js_module.As<Napi::Function>().Call(
              lynx_obj, {Napi::String::New(env, "GlobalEventEmitter")});
          if (env.IsExceptionPending()) {
            env.GetAndClearPendingException();
          } else if (auto found = extract(mod)) {
            return found;
          }
        } catch (...) {
          if (env.IsExceptionPending()) {
            env.GetAndClearPendingException();
          }
        }
      }
      Napi::Value get_app = lynx_obj.Get("getApp");
      if (get_app.IsFunction()) {
        try {
          Napi::Value app = get_app.As<Napi::Function>().Call(lynx_obj, {});
          if (env.IsExceptionPending()) {
            env.GetAndClearPendingException();
          } else if (app.IsObject()) {
            if (auto found =
                    extract(app.As<Napi::Object>().Get("GlobalEventEmitter"))) {
              return found;
            }
          }
        } catch (...) {
          if (env.IsExceptionPending()) {
            env.GetAndClearPendingException();
          }
        }
      }
      if (auto found = extract(lynx_obj.Get("GlobalEventEmitter"))) {
        return found;
      }
    }
    if (auto found = extract(global.Get("GlobalEventEmitter"))) {
      return found;
    }
  } catch (...) {
    if (env.IsExceptionPending()) {
      env.GetAndClearPendingException();
    }
  }
  return std::nullopt;
}

class NapiStreamEventSender {
 public:
  explicit NapiStreamEventSender(Napi::ThreadSafeFunction tsfn)
      : tsfn_(std::move(tsfn)) {}

  ~NapiStreamEventSender() { Release(); }

  void Send(const ps_sync_http::StreamEvent& ev) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (released_) {
      return;
    }
    auto* copy = new ps_sync_http::StreamEvent(ev);
    const napi_status status = tsfn_.NonBlockingCall(
        copy, [](Napi::Env env, Napi::Function fallback_fn,
                 ps_sync_http::StreamEvent* data) {
          std::unique_ptr<ps_sync_http::StreamEvent> owned(data);
          try {
            Napi::Object payload = Napi::Object::New(env);
            payload.Set("event", Napi::String::New(env, owned->event));
            if (owned->event == PS_SYNC_HTTP_EVENT_ON_DATA) {
              payload.Set("data", Napi::String::New(env, owned->data));
            } else if (owned->event == PS_SYNC_HTTP_EVENT_ON_ERROR) {
              payload.Set("error", Napi::String::New(env, owned->error));
            }
            Napi::String event_name = Napi::String::New(env, owned->stream_id);
            auto resolved = ResolveGlobalEventEmitter(env);
            if (resolved.has_value()) {
              if (resolved->is_trigger) {
                resolved->fn.Call(resolved->emitter, {event_name, payload});
              } else {
                Napi::Array params = Napi::Array::New(env, 1);
                params.Set(static_cast<uint32_t>(0), payload);
                resolved->fn.Call(resolved->emitter, {event_name, params});
              }
            } else if (!fallback_fn.IsEmpty()) {
              fallback_fn.Call({event_name, payload});
            }
          } catch (...) {
            if (env.IsExceptionPending()) {
              env.GetAndClearPendingException();
            }
          }
        });
    if (status != napi_ok) {
      delete copy;
    }
  }

  void Release() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!released_) {
      released_ = true;
      tsfn_.Release();
    }
  }

 private:
  std::mutex mutex_;
  Napi::ThreadSafeFunction tsfn_;
  bool released_ = false;
};

bool ParseHttpRequest(const Napi::Value& value,
                      ps_sync_http::HttpRequest* out, std::string* error) {
  if (!value.IsObject()) {
    *error = "httpFetch request must be an object";
    return false;
  }
  Napi::Object obj = value.As<Napi::Object>();
  if (!obj.Has("url") || !obj.Get("url").IsString()) {
    *error = "httpFetch requires string url";
    return false;
  }
  out->url = obj.Get("url").As<Napi::String>().Utf8Value();
  if (out->url.empty()) {
    *error = "httpFetch requires string url";
    return false;
  }
  if (obj.Has("method") && obj.Get("method").IsString()) {
    out->method = obj.Get("method").As<Napi::String>().Utf8Value();
  }
  if (out->method.empty()) {
    out->method = "GET";
  }
  if (obj.Has("body") && obj.Get("body").IsString()) {
    out->body = obj.Get("body").As<Napi::String>().Utf8Value();
  }
  if (obj.Has("headers") && obj.Get("headers").IsObject()) {
    Napi::Object headers = obj.Get("headers").As<Napi::Object>();
    Napi::Array keys = headers.GetPropertyNames();
    for (std::uint32_t i = 0; i < keys.Length(); ++i) {
      Napi::Value key_val = keys.Get(i);
      if (!key_val.IsString()) {
        continue;
      }
      const std::string key = key_val.As<Napi::String>().Utf8Value();
      Napi::Value val = headers.Get(key_val);
      if (val.IsUndefined() || val.IsNull()) {
        continue;
      }
      const std::string str_val = val.IsString()
                                      ? val.As<Napi::String>().Utf8Value()
                                      : val.ToString().Utf8Value();
      out->headers.emplace_back(key, str_val);
    }
  }
  return true;
}

Napi::Value HttpFetch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsFunction()) {
    return env.Undefined();
  }
  Napi::ThreadSafeFunction cb_tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "NativePowerSyncModule.httpFetch", 0,
      1);
  auto callback = std::make_shared<OneShotHttpCallback>(std::move(cb_tsfn));

  ps_sync_http::HttpRequest request;
  std::string parse_error;
  if (!ParseHttpRequest(info[0], &request, &parse_error)) {
    callback->Invoke(ps_sync_http::MakeFailEnvelope(parse_error));
    return env.Undefined();
  }

  ps_sync_http::StreamEventSender event_sender;
  if (ps_sync_http_is_sync_stream_url(request.url.c_str()) != 0) {
    auto resolved = ResolveGlobalEventEmitter(env);
    if (resolved.has_value()) {
      Napi::ThreadSafeFunction ev_tsfn = Napi::ThreadSafeFunction::New(
          env, resolved->fn, "NativePowerSyncModule.httpFetch.events", 0, 1);
      auto napi_sender =
          std::make_shared<NapiStreamEventSender>(std::move(ev_tsfn));
      event_sender = [napi_sender](const ps_sync_http::StreamEvent& ev) {
        napi_sender->Send(ev);
      };
    }
  }

  ps_sync_http::SharedSyncHttpEngine().Fetch(
      std::move(request), std::move(event_sender),
      [callback](ps_sync_http::HttpResponseEnvelope envelope) {
        callback->Invoke(std::move(envelope));
      });
  return env.Undefined();
}

Napi::Value HttpFetchAbort(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string stream_id;
  if (info.Length() >= 1 && info[0].IsString()) {
    stream_id = info[0].As<Napi::String>().Utf8Value();
  }

  ps_sync_http::SharedSyncHttpEngine().Abort(stream_id, nullptr);

  if (info.Length() >= 2 && info[1].IsFunction()) {
    try {
      Napi::Object ok_obj = Napi::Object::New(env);
      ok_obj.Set("ok", Napi::Boolean::New(env, true));
      info[1].As<Napi::Function>().Call({ok_obj});
    } catch (...) {
      if (env.IsExceptionPending()) {
        env.GetAndClearPendingException();
      }
    }
  }
  return env.Undefined();
}

void BindNativePowerSyncModule(napi_env env, napi_value exports) {
  Napi::Env napi_env(env);
  Napi::Object object = Napi::Object(napi_env, exports);
  object.Set("open", Napi::Function::New(napi_env, Open));
  object.Set("close", Napi::Function::New(napi_env, Close));
  object.Set("execute", Napi::Function::New(napi_env, Execute));
  object.Set("executeBatch", Napi::Function::New(napi_env, ExecuteBatch));
  object.Set("httpFetch", Napi::Function::New(napi_env, HttpFetch));
  object.Set("httpFetchAbort", Napi::Function::New(napi_env, HttpFetchAbort));
}

}  // namespace

extern "C" napi_value CreateNativePowerSyncModule(napi_env env,
                                                  napi_value exports,
                                                  const char* module_name,
                                                  void* opaque) {
  (void)module_name;
  (void)opaque;
  BindNativePowerSyncModule(env, exports);
  return exports;
}

extern "C" void SetNativePowerSyncStreamEventSender(
    ps_stream_event_sender_fn fn, void* opaque) {
  if (fn == nullptr) {
    ps_sync_http::SharedSyncHttpEngine().SetSharedStreamEventSender(nullptr);
    return;
  }
  ps_sync_http::SharedSyncHttpEngine().SetSharedStreamEventSender(
      [fn, opaque](const ps_sync_http::StreamEvent& ev) {
        fn(ev.stream_id.c_str(), ev.event.c_str(),
           ev.data.empty() ? nullptr : ev.data.c_str(),
           ev.error.empty() ? nullptr : ev.error.c_str(), opaque);
      });
}

#if defined(POWERSYNC_USE_LYNX_REGISTRATION)
LYNX_REGISTER_NATIVE_MODULE("NativePowerSyncModule", CreateNativePowerSyncModule,
                            nullptr);
#endif

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_undefs.h"
#endif
