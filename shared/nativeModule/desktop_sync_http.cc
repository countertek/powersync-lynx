#include "desktop_sync_http.h"

#include "sync_http_policy.h"
#include "sync_http_session.h"
#include "utf8_hold.h"

#include <utility>

namespace ps_desktop_http {

std::string Utf8ChunkBuffer::Push(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return {};
  }
  carry_.insert(carry_.end(), data, data + len);
  const size_t hold =
      ps_utf8_trailing_incomplete(carry_.data(), carry_.size());
  const size_t complete = carry_.size() - hold;
  if (complete == 0) {
    return {};
  }
  std::string out(reinterpret_cast<const char*>(carry_.data()), complete);
  if (hold > 0) {
    carry_.erase(carry_.begin(), carry_.begin() + static_cast<std::ptrdiff_t>(complete));
  } else {
    carry_.clear();
  }
  return out;
}

std::string Utf8ChunkBuffer::Flush() {
  if (carry_.empty()) {
    return {};
  }
  std::string out(reinterpret_cast<const char*>(carry_.data()), carry_.size());
  carry_.clear();
  return out;
}

std::string Base64Encode(const uint8_t* data, size_t len) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (data == nullptr || len == 0) {
    return {};
  }
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  while (i + 3 <= len) {
    const uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8) |
                       static_cast<uint32_t>(data[i + 2]);
    out.push_back(kAlphabet[(n >> 18) & 0x3f]);
    out.push_back(kAlphabet[(n >> 12) & 0x3f]);
    out.push_back(kAlphabet[(n >> 6) & 0x3f]);
    out.push_back(kAlphabet[n & 0x3f]);
    i += 3;
  }
  const size_t rem = len - i;
  if (rem == 1) {
    const uint32_t n = static_cast<uint32_t>(data[i]) << 16;
    out.push_back(kAlphabet[(n >> 18) & 0x3f]);
    out.push_back(kAlphabet[(n >> 12) & 0x3f]);
    out.push_back('=');
    out.push_back('=');
  } else if (rem == 2) {
    const uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8);
    out.push_back(kAlphabet[(n >> 18) & 0x3f]);
    out.push_back(kAlphabet[(n >> 12) & 0x3f]);
    out.push_back(kAlphabet[(n >> 6) & 0x3f]);
    out.push_back('=');
  }
  return out;
}

HttpResponseEnvelope MakeFailEnvelope(const std::string& message) {
  HttpResponseEnvelope env;
  env.ok = false;
  env.status = PS_SYNC_HTTP_FAIL_STATUS;
  env.status_text = "";
  env.message = message.empty() ? PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT : message;
  env.body = env.message;
  env.idle_complete = false;
  return env;
}

HttpResponseEnvelope MakeIdleErrorEnvelope(int status, const std::string& message) {
  HttpResponseEnvelope env;
  env.ok = false;
  env.status = (status == 0) ? PS_SYNC_HTTP_FAIL_STATUS : status;
  env.status_text = "";
  env.message = message.empty() ? PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT : message;
  env.body = env.message;
  env.body_base64 = "";
  env.has_body_base64 = true;
  env.content_type = "";
  env.idle_complete = false;
  return env;
}

HttpResponseEnvelope MakeIdleSuccessEnvelope(int status,
                                             const std::string& status_text,
                                             const std::vector<uint8_t>& bytes,
                                             const std::string& content_type,
                                             bool idle_complete) {
  HttpResponseEnvelope env;
  env.ok = true;
  env.status = status;
  env.status_text = status_text;
  env.content_type = content_type;
  if (!bytes.empty()) {
    env.body.assign(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    env.body_base64 = Base64Encode(bytes.data(), bytes.size());
  }
  env.has_body_base64 = true;
  env.idle_complete = idle_complete;
  return env;
}

void DesktopSyncHttp::SetSharedStreamEventSender(StreamEventSender sender) {
  std::lock_guard<std::mutex> lock(shared_sender_mutex_);
  shared_sender_ = std::move(sender);
}

StreamEventSender DesktopSyncHttp::ResolveEventSender(
    StreamEventSender per_call_sender) {
  if (per_call_sender) {
    return per_call_sender;
  }
  std::lock_guard<std::mutex> lock(shared_sender_mutex_);
  return shared_sender_;
}

void DesktopSyncHttp::ApplyEffects(const std::shared_ptr<StreamHandle>& handle,
                                   int effects, int status,
                                   const std::string& status_text,
                                   const std::string& content_type,
                                   const std::string& data,
                                   const std::string& error) {
  if (!handle || effects == PS_SYNC_HTTP_EFFECT_NONE) {
    return;
  }

  std::shared_ptr<PlatformStreamTask> task_to_cancel;
  {
    std::lock_guard<std::mutex> emit_lock(handle->emit_mutex);

    if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_HEADERS) != 0 &&
        handle->callback) {
      HttpResponseEnvelope env;
      env.ok = true;
      env.status = status;
      env.status_text = status_text;
      env.content_type = content_type;
      env.body = "";
      env.streaming_id = handle->stream_id;
      env.idle_complete = false;
      auto cb = std::move(handle->callback);
      handle->callback = nullptr;
      cb(std::move(env));
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL) != 0 &&
        handle->callback) {
      auto cb = std::move(handle->callback);
      handle->callback = nullptr;
      cb(MakeFailEnvelope(error));
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_DATA) != 0 && handle->sender) {
      StreamEvent ev;
      ev.stream_id = handle->stream_id;
      ev.event = PS_SYNC_HTTP_EVENT_ON_DATA;
      ev.data = data;
      handle->sender(ev);
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_ERROR) != 0 && handle->sender) {
      StreamEvent ev;
      ev.stream_id = handle->stream_id;
      ev.event = PS_SYNC_HTTP_EVENT_ON_ERROR;
      if (!error.empty()) {
        ev.error = error;
      } else if (handle->session.aborted.load() != 0) {
        ev.error = PS_SYNC_HTTP_ABORT_MESSAGE;
      } else {
        ev.error = PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT;
      }
      handle->sender(ev);
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_END) != 0 && handle->sender) {
      StreamEvent ev;
      ev.stream_id = handle->stream_id;
      ev.event = PS_SYNC_HTTP_EVENT_ON_END;
      handle->sender(ev);
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_CANCEL_IO) != 0) {
      std::lock_guard<std::mutex> task_lock(handle->task_mutex);
      handle->cancel_requested = true;
      task_to_cancel = handle->task;
    }

    if ((effects & PS_SYNC_HTTP_EFFECT_DROP) != 0) {
      {
        std::lock_guard<std::mutex> map_lock(active_streams_mutex_);
        active_streams_.erase(handle->stream_id);
      }
      handle->callback = nullptr;
      handle->sender = nullptr;
      std::lock_guard<std::mutex> task_lock(handle->task_mutex);
      handle->task.reset();
    }
  }

  if (task_to_cancel) {
    task_to_cancel->Cancel();
  }
}

void DesktopSyncHttp::Fetch(HttpRequest request, StreamEventSender event_sender,
                            EnvelopeCallback callback) {
  if (!callback) {
    return;
  }
  if (request.url.empty()) {
    callback(MakeFailEnvelope("httpFetch requires string url"));
    return;
  }
  if (request.method.empty()) {
    request.method = "GET";
  }

  const bool is_sync_stream =
      ps_sync_http_is_sync_stream_url(request.url.c_str()) != 0;
  StreamEventSender effective_sender =
      is_sync_stream ? ResolveEventSender(std::move(event_sender)) : nullptr;
  const int route = ps_sync_http_route(is_sync_stream ? 1 : 0,
                                       effective_sender ? 1 : 0);

  if (route != PS_SYNC_HTTP_ROUTE_STREAMING) {
    StartPlatformIdleCompleteRequest(request, is_sync_stream,
                                     std::move(callback));
    return;
  }

  auto handle = std::make_shared<StreamHandle>();
  ps_sync_http_session_init(&handle->session);
  handle->stream_id = std::string(PS_SYNC_HTTP_STREAM_EVENT_PREFIX) +
                      std::to_string(stream_counter_.fetch_add(1));
  handle->callback = std::move(callback);
  handle->sender = std::move(effective_sender);

  {
    std::lock_guard<std::mutex> lock(active_streams_mutex_);
    active_streams_[handle->stream_id] = handle;
  }

  std::weak_ptr<StreamHandle> weak_handle = handle;
  PlatformStreamCallbacks cbs;
  cbs.on_headers = [this, weak_handle](int status,
                                       const std::string& status_text,
                                       const std::string& content_type) {
    auto strong = weak_handle.lock();
    if (!strong) {
      return;
    }
    const int effects = ps_sync_http_session_on_headers(&strong->session);
    ApplyEffects(strong, effects, status, status_text, content_type, "", "");
  };

  cbs.on_bytes = [this, weak_handle](const uint8_t* data, size_t len) {
    auto strong = weak_handle.lock();
    if (!strong || data == nullptr || len == 0) {
      return;
    }
    std::string chunk;
    {
      std::lock_guard<std::mutex> emit_lock(strong->emit_mutex);
      chunk = strong->utf8_buf.Push(data, len);
    }
    if (chunk.empty()) {
      return;
    }
    const int effects = ps_sync_http_session_on_data(&strong->session);
    ApplyEffects(strong, effects, 0, "", "", chunk, "");
  };

  cbs.on_end = [this, weak_handle]() {
    auto strong = weak_handle.lock();
    if (!strong) {
      return;
    }
    std::string tail;
    if (strong->session.aborted.load() == 0) {
      std::lock_guard<std::mutex> emit_lock(strong->emit_mutex);
      tail = strong->utf8_buf.Flush();
    }
    if (!tail.empty()) {
      const int data_effects = ps_sync_http_session_on_data(&strong->session);
      ApplyEffects(strong, data_effects, 0, "", "", tail, "");
    }
    const int effects = ps_sync_http_session_on_end(&strong->session);
    ApplyEffects(strong, effects, 0, "", "", "", "");
  };

  cbs.on_error = [this, weak_handle](const std::string& error) {
    auto strong = weak_handle.lock();
    if (!strong) {
      return;
    }
    std::string tail;
    if (strong->session.aborted.load() == 0 &&
        strong->session.headers_sent.load() != 0) {
      std::lock_guard<std::mutex> emit_lock(strong->emit_mutex);
      tail = strong->utf8_buf.Flush();
    }
    if (!tail.empty()) {
      const int data_effects = ps_sync_http_session_on_data(&strong->session);
      ApplyEffects(strong, data_effects, 0, "", "", tail, "");
    }
    const int effects = ps_sync_http_session_on_error(&strong->session);
    ApplyEffects(strong, effects, 0, "", "", "", error);
  };

  auto task = StartPlatformStreamingRequest(request, std::move(cbs));
  bool need_cancel = false;
  {
    std::lock_guard<std::mutex> task_lock(handle->task_mutex);
    if (handle->session.terminal.load() == 0) {
      handle->task = task;
      need_cancel = handle->cancel_requested;
    }
  }
  if (need_cancel && task) {
    task->Cancel();
  }
}

void DesktopSyncHttp::Abort(const std::string& stream_id,
                            std::function<void()> callback) {
  std::shared_ptr<StreamHandle> handle;
  if (!stream_id.empty()) {
    std::lock_guard<std::mutex> lock(active_streams_mutex_);
    auto it = active_streams_.find(stream_id);
    if (it != active_streams_.end()) {
      handle = it->second;
    }
  }
  if (handle) {
    const int effects = ps_sync_http_session_abort(&handle->session);
    ApplyEffects(handle, effects, 0, "", "", "", "");
  }
  if (callback) {
    callback();
  }
}

DesktopSyncHttp& SharedDesktopSyncHttp() {
  static DesktopSyncHttp instance;
  return instance;
}

#if !defined(__APPLE__) && !defined(_WIN32)
namespace {
class UnsupportedPlatformStreamTask final : public PlatformStreamTask {
 public:
  void Cancel() override {}
};
}  // namespace

std::shared_ptr<PlatformStreamTask> StartPlatformStreamingRequest(
    const HttpRequest&, PlatformStreamCallbacks callbacks) {
  if (callbacks.on_error) {
    callbacks.on_error("Desktop NativeSyncHttp backend is only implemented on macOS and Windows");
  }
  return std::make_shared<UnsupportedPlatformStreamTask>();
}

void StartPlatformIdleCompleteRequest(const HttpRequest&, bool,
                                      EnvelopeCallback callback) {
  if (callback) {
    callback(MakeIdleErrorEnvelope(
        -1, "Desktop NativeSyncHttp backend is only implemented on macOS and Windows"));
  }
}
#endif

}  // namespace ps_desktop_http
