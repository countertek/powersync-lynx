#include <lynx/registration.h>

#include "ps_sql.h"

#include "napi.h"

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_defines.h"
#endif

#include <cmath>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>
#include <cstring>
#include <optional>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
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
  static Engine engine(MakeConfig());
  return engine;
}

std::string ModuleDirectory() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCSTR>(&ModuleDirectory),
                          &module)) {
    return ".";
  }
  char path[MAX_PATH];
  const DWORD n = GetModuleFileNameA(module, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) {
    return ".";
  }
  std::string full(path, n);
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

EngineConfig MakeConfig() {
  EngineConfig config;
#if defined(_WIN32)
  config.core_load = ps_sql::CoreLoad::kLoadExtension;
#else
  config.core_load = ps_sql::CoreLoad::kAutoExtension;
#endif
  config.core_path = ModuleDirectory() +
#if defined(_WIN32)
                     "\\"
#else
                     "/"
#endif
                     + CoreFileName();
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
    bind.blob.assign(data, data + buffer.ByteLength());
    return bind;
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

void BindNativePowerSyncModule(napi_env env, napi_value exports) {
  Napi::Env napi_env(env);
  Napi::Object object = Napi::Object(napi_env, exports);
  object.Set("open", Napi::Function::New(napi_env, Open));
  object.Set("close", Napi::Function::New(napi_env, Close));
  object.Set("execute", Napi::Function::New(napi_env, Execute));
  object.Set("executeBatch", Napi::Function::New(napi_env, ExecuteBatch));
}

napi_value CreateNativePowerSyncModule(::lynx::registration::LynxNapiEnv env,
                                       ::lynx::registration::LynxNapiValue exports,
                                       const char* module_name, void* opaque) {
  (void)module_name;
  (void)opaque;
  BindNativePowerSyncModule(env, exports);
  return exports;
}

}  // namespace

LYNX_REGISTER_NATIVE_MODULE("NativePowerSyncModule", CreateNativePowerSyncModule,
                            nullptr);

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_undefs.h"
#endif
