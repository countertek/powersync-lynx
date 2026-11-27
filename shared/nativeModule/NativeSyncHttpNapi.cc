#include "NativePowerSyncBindings.h"
#include "sync_http/sync_http_engine.h"
#include "sync_http_policy.h"

#include "napi.h"

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_defines.h"
#endif

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace {

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

// Holds persistent JS references to the resolved GlobalEventEmitter receiver
// so each onData chunk dispatches directly without re-probing globalThis/lynx.
// Owned by the TSFN finalize callback (runs on the JS thread).
struct CachedEmitterContext {
  Napi::ObjectReference emitter_ref;
  bool is_trigger = false;
};

struct StreamEventCall {
  ps_sync_http::StreamEvent event;
  CachedEmitterContext* emitter = nullptr;
};

class NapiStreamEventSender {
 public:
  NapiStreamEventSender(Napi::Env env, const ResolvedEmitter& resolved) {
    auto* ctx = new CachedEmitterContext{
        Napi::Persistent(resolved.emitter),
        resolved.is_trigger,
    };
    emitter_ctx_ = ctx;
    tsfn_ = Napi::ThreadSafeFunction::New(
        env, resolved.fn, "NativePowerSyncModule.httpFetch.events", 0, 1, ctx,
        [](Napi::Env, CachedEmitterContext* data) { delete data; });
  }

  ~NapiStreamEventSender() { Release(); }

  void Send(const ps_sync_http::StreamEvent& ev) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (released_) {
      return;
    }
    auto* call = new StreamEventCall{ev, emitter_ctx_};
    const napi_status status = tsfn_.NonBlockingCall(
        call, [](Napi::Env env, Napi::Function js_fn, StreamEventCall* data) {
          std::unique_ptr<StreamEventCall> owned(data);
          try {
            Napi::Object payload = Napi::Object::New(env);
            payload.Set("event", Napi::String::New(env, owned->event.event));
            if (owned->event.event == PS_SYNC_HTTP_EVENT_ON_DATA) {
              payload.Set("data", Napi::String::New(env, owned->event.data));
            } else if (owned->event.event == PS_SYNC_HTTP_EVENT_ON_ERROR) {
              payload.Set("error", Napi::String::New(env, owned->event.error));
            }
            Napi::String event_name =
                Napi::String::New(env, owned->event.stream_id);
            Napi::Object receiver = owned->emitter->emitter_ref.Value();
            if (owned->emitter->is_trigger) {
              js_fn.Call(receiver, {event_name, payload});
            } else {
              Napi::Array params = Napi::Array::New(env, 1);
              params.Set(static_cast<uint32_t>(0), payload);
              js_fn.Call(receiver, {event_name, params});
            }
          } catch (...) {
            if (env.IsExceptionPending()) {
              env.GetAndClearPendingException();
            }
          }
        });
    if (status != napi_ok) {
      delete call;
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
  CachedEmitterContext* emitter_ctx_ = nullptr;
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

ps_sync_http::SyncHttpEngine* HttpEngineFromInfo(
    const Napi::CallbackInfo& info) {
  return static_cast<ps_sync_http::SyncHttpEngine*>(info.Data());
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

  ps_sync_http::SyncHttpEngine* engine = HttpEngineFromInfo(info);
  ps_sync_http::StreamEventSender event_sender;
  // Honor SetNativePowerSyncStreamEventSender (C host override) before
  // auto-resolving PrimJS GlobalEventEmitter (ADR-0003).
  if (!engine->HasSharedStreamEventSender() &&
      ps_sync_http_is_sync_stream_url(request.url.c_str()) != 0) {
    auto resolved = ResolveGlobalEventEmitter(env);
    if (resolved.has_value()) {
      auto napi_sender =
          std::make_shared<NapiStreamEventSender>(env, *resolved);
      event_sender = [napi_sender](const ps_sync_http::StreamEvent& ev) {
        napi_sender->Send(ev);
      };
    }
  }

  engine->Fetch(std::move(request), std::move(event_sender),
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

  HttpEngineFromInfo(info)->Abort(stream_id);

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

}  // namespace

namespace ps_native_module {

void BindNativeSyncHttp(napi_env env, napi_value exports,
                        ps_sync_http::SyncHttpEngine& engine) {
  Napi::Env napi_env(env);
  Napi::Object object = Napi::Object(napi_env, exports);
  object.Set("httpFetch",
             Napi::Function::New(napi_env, HttpFetch, "httpFetch", &engine));
  object.Set("httpFetchAbort",
             Napi::Function::New(napi_env, HttpFetchAbort, "httpFetchAbort",
                                 &engine));
}

}  // namespace ps_native_module

#ifdef USE_WEAK_SUFFIX_NAPI
#include "weak_napi_undefs.h"
#endif
