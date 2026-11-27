#include "sync_http_engine.h"

#include <utility>

namespace ps_sync_http {

namespace {

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

HttpResponseEnvelope MakeIdleErrorEnvelope(int status,
                                           const std::string& message) {
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

HttpResponseEnvelope EnvelopeFromIdleOutcome(const IdleHttpOutcome& outcome,
                                             bool is_sync_stream) {
  if (!outcome.error.empty() && outcome.bytes.empty()) {
    return MakeIdleErrorEnvelope(outcome.status, outcome.error);
  }
  const bool idle_complete =
      is_sync_stream && (outcome.idle_timed_out || outcome.error.empty());
  return MakeIdleSuccessEnvelope(outcome.status, outcome.status_text,
                                 outcome.bytes, outcome.content_type,
                                 idle_complete);
}

}  // namespace

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

struct SyncHttpEngine::State {
  explicit State(std::shared_ptr<PlatformTransport> t) : transport(std::move(t)) {}

  StreamEventSender ResolveEventSender(StreamEventSender per_call_sender) {
    if (per_call_sender) {
      return per_call_sender;
    }
    std::lock_guard<std::mutex> lock(shared_sender_mutex);
    return shared_sender;
  }

  std::shared_ptr<PlatformTransport> transport;
  mutable std::mutex shared_sender_mutex;
  StreamEventSender shared_sender;

  std::mutex active_streams_mutex;
  bool shutting_down = false;
  std::unordered_map<std::string, std::shared_ptr<StreamHandle>> active_streams;
  std::atomic<long> stream_counter{0};
};

struct SyncHttpEngine::StreamHandle final : public StreamSessionSink {
  std::weak_ptr<State> state;
  std::string stream_id;
  EnvelopeCallback callback;
  StreamEventSender sender;
  SyncHttpStreamSession session;

  std::mutex task_mutex;
  std::shared_ptr<PlatformStreamTask> task;
  bool cancel_requested = false;

  void OnHeaders(int status, const std::string& status_text,
                 const std::string& content_type) override {
    if (!callback) {
      return;
    }
    HttpResponseEnvelope env;
    env.ok = true;
    env.status = status;
    env.status_text = status_text;
    env.content_type = content_type;
    env.body = "";
    env.streaming_id = stream_id;
    env.idle_complete = false;
    auto cb = std::move(callback);
    callback = nullptr;
    cb(std::move(env));
  }

  void OnFail(const std::string& message) override {
    if (!callback) {
      return;
    }
    auto cb = std::move(callback);
    callback = nullptr;
    cb(MakeFailEnvelope(message));
  }

  void OnData(const std::string& utf8_chunk) override {
    if (!sender) {
      return;
    }
    StreamEvent ev;
    ev.stream_id = stream_id;
    ev.event = PS_SYNC_HTTP_EVENT_ON_DATA;
    ev.data = utf8_chunk;
    sender(ev);
  }

  void OnError(const std::string& message) override {
    if (!sender) {
      return;
    }
    StreamEvent ev;
    ev.stream_id = stream_id;
    ev.event = PS_SYNC_HTTP_EVENT_ON_ERROR;
    ev.error = message;
    sender(ev);
  }

  void OnEnd() override {
    if (!sender) {
      return;
    }
    StreamEvent ev;
    ev.stream_id = stream_id;
    ev.event = PS_SYNC_HTTP_EVENT_ON_END;
    sender(ev);
  }

  void CancelIo() override {
    std::shared_ptr<PlatformStreamTask> to_cancel;
    {
      std::lock_guard<std::mutex> lock(task_mutex);
      cancel_requested = true;
      to_cancel = task;
    }
    if (to_cancel) {
      to_cancel->Cancel();
    }
  }

  void OnDrop() override {
    if (auto strong_state = state.lock()) {
      std::lock_guard<std::mutex> map_lock(strong_state->active_streams_mutex);
      strong_state->active_streams.erase(stream_id);
    }
    callback = nullptr;
    sender = nullptr;
    std::lock_guard<std::mutex> task_lock(task_mutex);
    task.reset();
  }
};

SyncHttpEngine::SyncHttpEngine(std::shared_ptr<PlatformTransport> transport)
    : state_(std::make_shared<State>(
          transport ? std::move(transport) : DefaultPlatformTransport())) {}

SyncHttpEngine::~SyncHttpEngine() { Shutdown(); }

void SyncHttpEngine::SetSharedStreamEventSender(StreamEventSender sender) {
  std::lock_guard<std::mutex> lock(state_->shared_sender_mutex);
  state_->shared_sender = std::move(sender);
}

bool SyncHttpEngine::HasSharedStreamEventSender() const {
  std::lock_guard<std::mutex> lock(state_->shared_sender_mutex);
  return static_cast<bool>(state_->shared_sender);
}

void SyncHttpEngine::Fetch(HttpRequest request, StreamEventSender event_sender,
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
      is_sync_stream ? state_->ResolveEventSender(std::move(event_sender))
                     : nullptr;
  const int route = Route(is_sync_stream, static_cast<bool>(effective_sender));

  if (route != PS_SYNC_HTTP_ROUTE_STREAMING) {
    EnvelopeCallback cb = std::move(callback);
    state_->transport->StartIdleComplete(
        request, is_sync_stream,
        [cb = std::move(cb), is_sync_stream](IdleHttpOutcome outcome) mutable {
          cb(EnvelopeFromIdleOutcome(outcome, is_sync_stream));
        });
    return;
  }

  auto handle = std::make_shared<StreamHandle>();
  handle->state = state_;
  handle->stream_id = std::string(PS_SYNC_HTTP_STREAM_EVENT_PREFIX) +
                      std::to_string(state_->stream_counter.fetch_add(1));
  handle->callback = std::move(callback);
  handle->sender = std::move(effective_sender);

  {
    std::lock_guard<std::mutex> lock(state_->active_streams_mutex);
    if (state_->shutting_down) {
      auto cb = std::move(handle->callback);
      handle->callback = nullptr;
      cb(MakeFailEnvelope(PS_SYNC_HTTP_ABORT_MESSAGE));
      return;
    }
    state_->active_streams[handle->stream_id] = handle;
  }

  std::weak_ptr<StreamHandle> weak_handle = handle;
  PlatformStreamCallbacks cbs;
  cbs.on_headers = [weak_handle](int status, const std::string& status_text,
                                 const std::string& content_type) {
    if (auto strong = weak_handle.lock()) {
      strong->session.OnHeaders(status, status_text, content_type, *strong);
    }
  };
  cbs.on_bytes = [weak_handle](const uint8_t* data, size_t len) {
    if (auto strong = weak_handle.lock()) {
      strong->session.OnBytes(data, len, *strong);
    }
  };
  cbs.on_end = [weak_handle]() {
    if (auto strong = weak_handle.lock()) {
      strong->session.OnEnd(*strong);
    }
  };
  cbs.on_error = [weak_handle](const std::string& error) {
    if (auto strong = weak_handle.lock()) {
      strong->session.OnError(error, *strong);
    }
  };

  auto task = state_->transport->StartStreaming(request, std::move(cbs));
  bool need_cancel = false;
  {
    std::lock_guard<std::mutex> task_lock(handle->task_mutex);
    if (!handle->session.IsTerminal()) {
      handle->task = task;
      need_cancel = handle->cancel_requested;
    }
  }
  if (need_cancel && task) {
    task->Cancel();
  }
}

void SyncHttpEngine::Abort(const std::string& stream_id) {
  std::shared_ptr<StreamHandle> handle;
  if (!stream_id.empty()) {
    std::lock_guard<std::mutex> lock(state_->active_streams_mutex);
    auto it = state_->active_streams.find(stream_id);
    if (it != state_->active_streams.end()) {
      handle = it->second;
    }
  }
  if (handle) {
    handle->session.Abort(*handle);
  }
}

void SyncHttpEngine::Shutdown() {
  std::vector<std::shared_ptr<StreamHandle>> handles;
  {
    std::lock_guard<std::mutex> lock(state_->active_streams_mutex);
    state_->shutting_down = true;
    handles.reserve(state_->active_streams.size());
    for (auto& kv : state_->active_streams) {
      handles.push_back(kv.second);
    }
    state_->active_streams.clear();
  }
  for (auto& handle : handles) {
    handle->session.Abort(*handle);
  }
}

SyncHttpEngine& SharedSyncHttpEngine() {
  // Intentionally heap-allocated so exit-time static destruction never races
  // in-flight platform HTTP callbacks or ObjC/PrimJS runtime teardown.
  static SyncHttpEngine* instance = new SyncHttpEngine();
  return *instance;
}

#if !defined(__APPLE__) && !defined(_WIN32)
namespace {

class UnsupportedPlatformStreamTask final : public PlatformStreamTask {
 public:
  void Cancel() override {}
};

class UnsupportedPlatformTransport final : public PlatformTransport {
 public:
  std::shared_ptr<PlatformStreamTask> StartStreaming(
      const HttpRequest&, PlatformStreamCallbacks callbacks) override {
    if (callbacks.on_error) {
      callbacks.on_error(
          "NativeSyncHttp backend is only implemented on Apple and Windows");
    }
    return std::make_shared<UnsupportedPlatformStreamTask>();
  }

  void StartIdleComplete(const HttpRequest&, bool,
                         IdleOutcomeCallback callback) override {
    if (callback) {
      IdleHttpOutcome outcome;
      outcome.status = PS_SYNC_HTTP_FAIL_STATUS;
      outcome.error =
          "NativeSyncHttp backend is only implemented on Apple and Windows";
      callback(std::move(outcome));
    }
  }
};

}  // namespace

std::shared_ptr<PlatformTransport> DefaultPlatformTransport() {
  return std::make_shared<UnsupportedPlatformTransport>();
}
#endif

}  // namespace ps_sync_http
