#include "sync_http/sync_http_engine.h"
#include "sync_stream_fixtures.h"

#if defined(__APPLE__) || defined(_WIN32)
#include "ndjson_http_replay.h"
#endif

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void expect(bool cond, const char* what) {
  if (!cond) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_failures;
  } else {
    std::printf("ok: %s\n", what);
  }
}

struct EventRecorder {
  std::mutex mu;
  std::condition_variable cv;
  std::vector<ps_sync_http::StreamEvent> events;

  ps_sync_http::StreamEventSender sender() {
    return [this](const ps_sync_http::StreamEvent& ev) {
      {
        std::lock_guard<std::mutex> lock(mu);
        events.push_back(ev);
      }
      cv.notify_all();
    };
  }

  bool wait_for_event(const std::string& event_name, int timeout_ms = 10000) {
    std::unique_lock<std::mutex> lock(mu);
    return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&] {
      for (const auto& ev : events) {
        if (ev.event == event_name) {
          return true;
        }
      }
      return false;
    });
  }

  bool wait_for_count(size_t count, int timeout_ms = 10000) {
    std::unique_lock<std::mutex> lock(mu);
    return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                       [&] { return events.size() >= count; });
  }

  std::vector<ps_sync_http::StreamEvent> snapshot() {
    std::lock_guard<std::mutex> lock(mu);
    return events;
  }

  std::string joined_data() {
    std::lock_guard<std::mutex> lock(mu);
    std::string out;
    for (const auto& ev : events) {
      if (ev.event == PS_SYNC_HTTP_EVENT_ON_DATA) {
        out += ev.data;
      }
    }
    return out;
  }

  bool has_event(const std::string& name) {
    std::lock_guard<std::mutex> lock(mu);
    for (const auto& ev : events) {
      if (ev.event == name) {
        return true;
      }
    }
    return false;
  }
};

bool WaitEnvelope(ps_sync_http::SyncHttpEngine& http,
                  ps_sync_http::HttpRequest req,
                  ps_sync_http::StreamEventSender sender,
                  ps_sync_http::HttpResponseEnvelope* out,
                  int timeout_ms = 15000) {
  std::mutex mu;
  std::condition_variable cv;
  bool done = false;
  http.Fetch(std::move(req), std::move(sender),
             [&](ps_sync_http::HttpResponseEnvelope env) {
               {
                 std::lock_guard<std::mutex> lock(mu);
                 *out = std::move(env);
                 done = true;
               }
               cv.notify_one();
             });
  std::unique_lock<std::mutex> lock(mu);
  return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                     [&] { return done; });
}

class FakeStreamTask final : public ps_sync_http::PlatformStreamTask {
 public:
  std::atomic<int> cancel_calls{0};
  std::function<void()> on_cancel;

  void Cancel() override {
    cancel_calls.fetch_add(1);
    if (on_cancel) {
      auto fn = std::move(on_cancel);
      fn();
    }
  }
};

class FakeTransport final : public ps_sync_http::PlatformTransport {
 public:
  std::shared_ptr<FakeStreamTask> last_task;
  ps_sync_http::PlatformStreamCallbacks last_callbacks;
  std::function<void(ps_sync_http::PlatformStreamCallbacks&)> on_start_streaming;
  ps_sync_http::IdleHttpOutcome next_idle_outcome;

  FakeTransport() {
    next_idle_outcome.status = 200;
    next_idle_outcome.status_text = "OK";
    next_idle_outcome.content_type = "application/json";
  }

  std::shared_ptr<ps_sync_http::PlatformStreamTask> StartStreaming(
      const ps_sync_http::HttpRequest&,
      ps_sync_http::PlatformStreamCallbacks callbacks) override {
    last_task = std::make_shared<FakeStreamTask>();
    last_callbacks = std::move(callbacks);
    if (on_start_streaming) {
      on_start_streaming(last_callbacks);
    }
    return last_task;
  }

  void StartIdleComplete(const ps_sync_http::HttpRequest&, bool,
                         ps_sync_http::IdleOutcomeCallback callback) override {
    if (callback) {
      callback(next_idle_outcome);
    }
  }
};

}  // namespace

int main() {
  ps_sync_fixtures::Catalog catalog;
  try {
    catalog = ps_sync_fixtures::load_default();
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: sync_http load fixtures: %s\n", ex.what());
    return 1;
  }

  const auto* checkpoint =
      ps_sync_fixtures::find_scenario(catalog, "checkpoint-ops");
  const auto* idle = ps_sync_fixtures::find_scenario(catalog, "idle-complete");
  const auto* split =
      ps_sync_fixtures::find_scenario(catalog, "split-multibyte");
  const auto* errored =
      ps_sync_fixtures::find_scenario(catalog, "error-then-end");
  expect(checkpoint != nullptr && idle != nullptr && split != nullptr &&
             errored != nullptr,
         "sync_http loaded all shared NDJSON scenarios");
  if (checkpoint == nullptr || idle == nullptr || split == nullptr ||
      errored == nullptr) {
    return 1;
  }

  // 1. In-memory idle-complete envelope & Base64 policy owned by SyncHttpEngine.
  {
    auto transport = std::make_shared<FakeTransport>();
    ps_sync_http::SyncHttpEngine http(transport);
    const std::string sample = "hello";

    // Non-sync buffered response: Base64 encoded, idleComplete=false.
    transport->next_idle_outcome = ps_sync_http::IdleHttpOutcome{};
    transport->next_idle_outcome.status = 200;
    transport->next_idle_outcome.status_text = "OK";
    transport->next_idle_outcome.content_type = "application/json";
    transport->next_idle_outcome.bytes.assign(sample.begin(), sample.end());
    ps_sync_http::HttpRequest req;
    req.method = "GET";
    req.url = "http://example.test/token";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, nullptr, &env),
           "in-memory buffered JSON returns envelope");
    expect(env.ok && env.status == 200 && !env.idle_complete &&
               env.body == "hello" && env.body_base64 == "aGVsbG8=",
           "SyncHttpEngine owns Base64 encoding and idleComplete=false for non-sync");

    // /sync/stream idle cutoff -> idleComplete=true.
    transport->next_idle_outcome.idle_timed_out = true;
    req.url = "http://example.test/sync/stream";
    expect(WaitEnvelope(http, req, nullptr, &env),
           "in-memory /sync/stream idle cutoff returns envelope");
    expect(env.ok && env.idle_complete && env.body_base64 == "aGVsbG8=",
           "SyncHttpEngine sets idleComplete=true on /sync/stream idle cutoff");

    // Empty-body error -> ok=false, status=-1, idleComplete=false.
    transport->next_idle_outcome = ps_sync_http::IdleHttpOutcome{};
    transport->next_idle_outcome.error = "boom";
    expect(WaitEnvelope(http, req, nullptr, &env),
           "in-memory idle error returns envelope");
    expect(!env.ok && env.status == PS_SYNC_HTTP_FAIL_STATUS &&
               env.message == "boom" && !env.idle_complete &&
               env.streaming_id.empty(),
           "SyncHttpEngine maps empty-body IdleHttpOutcome error to N3 fail envelope");
  }

  // 2. Parse error: missing url -> pre-headers fail envelope, zero events.
  {
    ps_sync_http::SyncHttpEngine http(std::make_shared<FakeTransport>());
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "sync_http missing-url returns immediately");
    expect(!env.ok && env.status == PS_SYNC_HTTP_FAIL_STATUS &&
               !env.message.empty() && !env.idle_complete &&
               env.streaming_id.empty(),
           "sync_http missing-url fail envelope matches N3");
    expect(rec.snapshot().empty(),
           "sync_http missing-url emits zero stream events");
  }

  // 3. Deterministic in-memory transport: abort-before-task-assign + split-multibyte.
  {
    auto transport = std::make_shared<FakeTransport>();
    ps_sync_http::SyncHttpEngine http(transport);
    EventRecorder rec;
    ps_sync_http::HttpResponseEnvelope env;

    // Abort triggered synchronously inside on_headers before StartStreaming returns.
    transport->on_start_streaming = [&](ps_sync_http::PlatformStreamCallbacks& cbs) {
      cbs.on_headers(200, "OK", catalog.content_type);
      http.Abort(env.streaming_id);
    };
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = "http://example.test/sync/stream";
    http.Fetch(req, rec.sender(), [&](ps_sync_http::HttpResponseEnvelope e) { env = std::move(e); });
    expect(env.ok && !env.streaming_id.empty(),
           "in-memory abort-before-assign delivers headers");
    expect(transport->last_task && transport->last_task->cancel_calls.load() == 1,
           "in-memory abort-before-assign cancels task once StartStreaming returns");
    transport->last_callbacks.on_error(PS_SYNC_HTTP_ABORT_MESSAGE);
    const auto evs = rec.snapshot();
    expect(evs.size() == 2 && evs[0].event == PS_SYNC_HTTP_EVENT_ON_ERROR &&
               evs[0].error == PS_SYNC_HTTP_ABORT_MESSAGE &&
               evs[1].event == PS_SYNC_HTTP_EVENT_ON_END,
           "in-memory abort-before-assign emits onError(aborted) -> onEnd");
  }

  // 4. Deterministic in-memory transport: destroying SyncHttpEngine mid-stream
  // cancels active tasks and safely ignores late callbacks (no dangling this).
  {
    auto transport = std::make_shared<FakeTransport>();
    EventRecorder rec;
    {
      ps_sync_http::SyncHttpEngine http(transport);
      ps_sync_http::HttpRequest req;
      req.method = "POST";
      req.url = "http://example.test/sync/stream";
      http.Fetch(req, rec.sender(), [](ps_sync_http::HttpResponseEnvelope) {});
      transport->last_callbacks.on_headers(200, "OK", catalog.content_type);
      // Destroy `http` while the task is still open.
    }
    expect(transport->last_task && transport->last_task->cancel_calls.load() == 1,
           "SyncHttpEngine destructor cancels active stream tasks");
    // Late callbacks arriving after engine destruction must not crash or touch freed memory.
    const std::string late = "{\"late\":true}\n";
    transport->last_callbacks.on_bytes(
        reinterpret_cast<const uint8_t*>(late.data()), late.size());
    transport->last_callbacks.on_error(PS_SYNC_HTTP_ABORT_MESSAGE);
    expect(true, "late callbacks after SyncHttpEngine destruction are safe");
  }

#if defined(__APPLE__) || defined(_WIN32)
  // 5. Real platform adapter (Apple NSURLSession / Windows WinHTTP) streaming: checkpoint-ops.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = checkpoint->chunks;
    expect(server.start(cfg), "platform checkpoint-ops replay server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.headers = {{"Accept", "application/x-ndjson"}};
    req.body = "{}";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "platform checkpoint-ops headers callback fires");
    expect(env.ok && env.status == 200, "platform checkpoint-ops HTTP 200 ok");
    expect(env.streaming_id.rfind(PS_SYNC_HTTP_STREAM_EVENT_PREFIX, 0) == 0,
           "platform checkpoint-ops returns streamingId");
    expect(!env.idle_complete && env.body.empty(),
           "platform checkpoint-ops streaming envelope has empty body & idleComplete=false");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "platform checkpoint-ops reaches onEnd");
    const auto evs = rec.snapshot();
    expect(!evs.empty() && evs.front().event == PS_SYNC_HTTP_EVENT_ON_DATA &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "platform checkpoint-ops emits onData* -> onEnd");
    expect(!rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR),
           "platform checkpoint-ops has no onError");
    expect(rec.joined_data() == ps_sync_fixtures::joined_body(*checkpoint),
           "platform checkpoint-ops joined onData matches fixture NDJSON");
    server.stop();
  }

  // 6. Platform adapter split-multibyte across TCP chunks (gap_ms=30).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = ps_sync_fixtures::wire_chunks(*split);
    cfg.gap_ms = 30;
    expect(server.start(cfg), "platform split-multibyte replay server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok,
           "platform split-multibyte headers ok");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "platform split-multibyte reaches onEnd");
    expect(!rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR),
           "platform split-multibyte has no onError");
    expect(rec.joined_data() == ps_sync_fixtures::joined_body(*split),
           "platform split-multibyte reassembles UTF-8 euro without corruption");
    server.stop();
  }

  // 7. Platform adapter idle-complete fallback (no event sender).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = idle->chunks;
    expect(server.start(cfg), "platform idle-complete replay server starts");

    ps_sync_http::SyncHttpEngine http;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, nullptr, &env),
           "platform idle-complete callback fires");
    expect(env.ok && env.status == 200 && env.streaming_id.empty() &&
               env.idle_complete && !env.body_base64.empty(),
           "platform idle-complete envelope shape matches fixture contract");
    expect(env.body == ps_sync_fixtures::joined_body(*idle),
           "platform idle-complete body matches fixture NDJSON");
    server.stop();
  }

  // 8. Platform adapter non-streaming JSON (/token) even when sender exists.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = "application/json";
    cfg.chunks = {"{\"token\":\"abc-123\"}"};
    expect(server.start(cfg), "platform JSON /token replay server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "GET";
    req.url = server.url("/token");
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "platform JSON /token callback fires");
    expect(env.ok && env.status == 200 && env.streaming_id.empty() &&
               !env.idle_complete && env.body == "{\"token\":\"abc-123\"}",
           "platform JSON /token returns buffered body with no streamingId");
    expect(rec.snapshot().empty(),
           "platform JSON /token emits zero stream events");
    server.stop();
  }

  // 9. Platform adapter hold-open streaming + Abort cancellation.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = checkpoint->chunks;
    cfg.hold_open = true;
    expect(server.start(cfg), "platform hold-open server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok &&
               !env.streaming_id.empty(),
           "platform hold-open returns streamingId before EOF");
    expect(rec.wait_for_count(1),
           "platform hold-open delivers incremental onData while stream stays open");
    http.Abort(env.streaming_id);
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "platform abort emits terminal onEnd promptly");
    const auto evs = rec.snapshot();
    expect(rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR) &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "platform abort emits onError then onEnd");
    server.stop();
  }

  // 10. Platform adapter RST before headers -> fail Callback, no events.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.rst_before_headers = true;
    expect(server.start(cfg), "platform RST-before-headers server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "GET";
    req.url = server.url("/sync/stream");
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "platform RST-before-headers callback fires");
    expect(!env.ok && env.status == PS_SYNC_HTTP_FAIL_STATUS &&
               !env.message.empty() && !env.idle_complete &&
               env.streaming_id.empty(),
           "platform RST-before-headers returns pre-headers fail envelope");
    expect(rec.snapshot().empty(),
           "platform RST-before-headers emits zero stream events");
    server.stop();
  }

  // 11. Platform adapter error-then-end (RST after first chunk).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = errored->chunks;
    cfg.rst_after_first_chunk = true;
    expect(server.start(cfg), "platform error-then-end RST server starts");

    ps_sync_http::SyncHttpEngine http;
    EventRecorder rec;
    ps_sync_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_sync_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok,
           "platform error-then-end headers ok");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "platform error-then-end reaches onEnd");
    const auto evs = rec.snapshot();
    expect(rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR) &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "platform error-then-end emits onError then onEnd");
    server.stop();
  }
#endif

  if (g_failures != 0) {
    std::fprintf(stderr, "%d sync-http engine test(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all shared SyncHttpEngine checks passed\n");
  return 0;
}
