#include "desktop_sync_http.h"
#include "sync_stream_fixtures.h"

#if defined(__APPLE__) || defined(_WIN32)
#include "ndjson_http_replay.h"
#endif

#include <chrono>
#include <condition_variable>
#include <cstdio>
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
  std::vector<ps_desktop_http::StreamEvent> events;

  ps_desktop_http::StreamEventSender sender() {
    return [this](const ps_desktop_http::StreamEvent& ev) {
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

  std::vector<ps_desktop_http::StreamEvent> snapshot() {
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

bool WaitEnvelope(ps_desktop_http::DesktopSyncHttp& http,
                  ps_desktop_http::HttpRequest req,
                  ps_desktop_http::StreamEventSender sender,
                  ps_desktop_http::HttpResponseEnvelope* out,
                  int timeout_ms = 15000) {
  std::mutex mu;
  std::condition_variable cv;
  bool done = false;
  http.Fetch(std::move(req), std::move(sender),
             [&](ps_desktop_http::HttpResponseEnvelope env) {
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

bool WaitAbort(ps_desktop_http::DesktopSyncHttp& http,
               const std::string& stream_id, int timeout_ms = 5000) {
  std::mutex mu;
  std::condition_variable cv;
  bool done = false;
  http.Abort(stream_id, [&]() {
    {
      std::lock_guard<std::mutex> lock(mu);
      done = true;
    }
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mu);
  return cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                     [&] { return done; });
}

}  // namespace

int main() {
  ps_sync_fixtures::Catalog catalog;
  try {
    catalog = ps_sync_fixtures::load_default();
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: desktop load fixtures: %s\n", ex.what());
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
         "desktop loaded all shared NDJSON scenarios");
  if (checkpoint == nullptr || idle == nullptr || split == nullptr ||
      errored == nullptr) {
    return 1;
  }

  // 1. Cross-platform Utf8ChunkBuffer + split-multibyte wire fixture.
  {
    const auto wire = ps_sync_fixtures::wire_chunks(*split);
    ps_desktop_http::Utf8ChunkBuffer buf;
    std::vector<std::string> emitted;
    for (const auto& piece : wire) {
      std::string out = buf.Push(
          reinterpret_cast<const uint8_t*>(piece.data()), piece.size());
      if (!out.empty()) {
        emitted.push_back(std::move(out));
      }
    }
    std::string tail = buf.Flush();
    if (!tail.empty()) {
      emitted.push_back(std::move(tail));
    }
    expect(emitted == split->chunks,
           "desktop Utf8ChunkBuffer matches split-multibyte fixture chunks");
  }

  // 2. Base64 + fail envelope helpers.
  {
    const std::string sample = "hello";
    expect(ps_desktop_http::Base64Encode(
               reinterpret_cast<const uint8_t*>(sample.data()), sample.size()) ==
               "aGVsbG8=",
           "desktop Base64Encode encodes UTF-8 bytes");
    const auto fail = ps_desktop_http::MakeFailEnvelope("boom");
    expect(!fail.ok && fail.status == PS_SYNC_HTTP_FAIL_STATUS &&
               fail.message == "boom" && !fail.idle_complete &&
               fail.streaming_id.empty(),
           "desktop MakeFailEnvelope matches N3 contract");
  }

  // 3. Parse error: missing url -> pre-headers fail envelope, zero events.
  {
    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "desktop missing-url returns immediately");
    expect(!env.ok && env.status == PS_SYNC_HTTP_FAIL_STATUS &&
               !env.message.empty() && !env.idle_complete &&
               env.streaming_id.empty(),
           "desktop missing-url fail envelope matches N3");
    expect(rec.snapshot().empty(),
           "desktop missing-url emits zero stream events");
  }

#if defined(__APPLE__) || defined(_WIN32)
  // 4. Desktop (macOS NSURLSession / Windows WinHTTP) streaming replay: checkpoint-ops.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = checkpoint->chunks;
    expect(server.start(cfg), "macOS checkpoint-ops replay server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.headers = {{"Accept", "application/x-ndjson"}};
    req.body = "{}";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "macOS checkpoint-ops headers callback fires");
    expect(env.ok && env.status == 200, "macOS checkpoint-ops HTTP 200 ok");
    expect(env.streaming_id.rfind(PS_SYNC_HTTP_STREAM_EVENT_PREFIX, 0) == 0,
           "macOS checkpoint-ops returns streamingId");
    expect(!env.idle_complete && env.body.empty(),
           "macOS checkpoint-ops streaming envelope has empty body & idleComplete=false");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "macOS checkpoint-ops reaches onEnd");
    const auto evs = rec.snapshot();
    expect(!evs.empty() && evs.front().event == PS_SYNC_HTTP_EVENT_ON_DATA &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "macOS checkpoint-ops emits onData* -> onEnd");
    expect(!rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR),
           "macOS checkpoint-ops has no onError");
    expect(rec.joined_data() == ps_sync_fixtures::joined_body(*checkpoint),
           "macOS checkpoint-ops joined onData matches fixture NDJSON");
    server.stop();
  }

  // 5. macOS NSURLSession split-multibyte across TCP chunks (gap_ms=30).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = ps_sync_fixtures::wire_chunks(*split);
    cfg.gap_ms = 30;
    expect(server.start(cfg), "macOS split-multibyte replay server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok,
           "macOS split-multibyte headers ok");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "macOS split-multibyte reaches onEnd");
    expect(!rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR),
           "macOS split-multibyte has no onError");
    expect(rec.joined_data() == ps_sync_fixtures::joined_body(*split),
           "macOS split-multibyte reassembles UTF-8 euro without corruption");
    server.stop();
  }

  // 6. macOS NSURLSession idle-complete fallback (no event sender).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = idle->chunks;
    expect(server.start(cfg), "macOS idle-complete replay server starts");

    ps_desktop_http::DesktopSyncHttp http;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, nullptr, &env),
           "macOS idle-complete callback fires");
    expect(env.ok && env.status == 200 && env.streaming_id.empty() &&
               env.idle_complete && !env.body_base64.empty(),
           "macOS idle-complete envelope shape matches fixture contract");
    expect(env.body == ps_sync_fixtures::joined_body(*idle),
           "macOS idle-complete body matches fixture NDJSON");
    server.stop();
  }

  // 7. macOS NSURLSession non-streaming JSON (/token) even when sender exists.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = "application/json";
    cfg.chunks = {"{\"token\":\"abc-123\"}"};
    expect(server.start(cfg), "macOS JSON /token replay server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "GET";
    req.url = server.url("/token");
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "macOS JSON /token callback fires");
    expect(env.ok && env.status == 200 && env.streaming_id.empty() &&
               !env.idle_complete && env.body == "{\"token\":\"abc-123\"}",
           "macOS JSON /token returns buffered body with no streamingId");
    expect(rec.snapshot().empty(),
           "macOS JSON /token emits zero stream events");
    server.stop();
  }

  // 8. macOS NSURLSession hold-open streaming + Abort cancellation.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = checkpoint->chunks;
    cfg.hold_open = true;
    expect(server.start(cfg), "macOS hold-open server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok &&
               !env.streaming_id.empty(),
           "macOS hold-open returns streamingId before EOF");
    expect(rec.wait_for_count(1),
           "macOS hold-open delivers incremental onData while stream stays open");
    expect(WaitAbort(http, env.streaming_id),
           "macOS httpFetchAbort returns immediately");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "macOS abort emits terminal onEnd promptly");
    const auto evs = rec.snapshot();
    expect(rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR) &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "macOS abort emits onError then onEnd");
    server.stop();
  }

  // 9. macOS NSURLSession RST before headers -> fail Callback, no events.
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.rst_before_headers = true;
    expect(server.start(cfg), "macOS RST-before-headers server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "GET";
    req.url = server.url("/sync/stream");
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env),
           "macOS RST-before-headers callback fires");
    expect(!env.ok && env.status == PS_SYNC_HTTP_FAIL_STATUS &&
               !env.message.empty() && !env.idle_complete &&
               env.streaming_id.empty(),
           "macOS RST-before-headers returns pre-headers fail envelope");
    expect(rec.snapshot().empty(),
           "macOS RST-before-headers emits zero stream events");
    server.stop();
  }

  // 10. macOS NSURLSession error-then-end (RST after first chunk).
  {
    ps_sync_fixtures::NdjsonReplayServer server;
    ps_sync_fixtures::ReplayConfig cfg;
    cfg.content_type = catalog.content_type;
    cfg.chunks = errored->chunks;
    cfg.rst_after_first_chunk = true;
    expect(server.start(cfg), "macOS error-then-end RST server starts");

    ps_desktop_http::DesktopSyncHttp http;
    EventRecorder rec;
    ps_desktop_http::HttpRequest req;
    req.method = "POST";
    req.url = server.url("/sync/stream");
    req.body = "{}";
    ps_desktop_http::HttpResponseEnvelope env;
    expect(WaitEnvelope(http, req, rec.sender(), &env) && env.ok,
           "macOS error-then-end headers ok");
    expect(rec.wait_for_event(PS_SYNC_HTTP_EVENT_ON_END),
           "macOS error-then-end reaches onEnd");
    const auto evs = rec.snapshot();
    expect(rec.has_event(PS_SYNC_HTTP_EVENT_ON_ERROR) &&
               evs.back().event == PS_SYNC_HTTP_EVENT_ON_END,
           "macOS error-then-end emits onError then onEnd");
    server.stop();
  }
#endif

  if (g_failures != 0) {
    std::fprintf(stderr, "%d desktop sync-http test(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all desktop NativeSyncHttp checks passed\n");
  return 0;
}
