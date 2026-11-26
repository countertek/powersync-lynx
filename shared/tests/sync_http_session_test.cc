#include "sync_http/sync_http_session.h"
#include "sync_stream_fixtures.h"

#include <cstdio>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#ifndef PS_SYNC_STREAM_FIXTURES_PATH
#define PS_SYNC_STREAM_FIXTURES_PATH "shared/fixtures/sync-stream.json"
#endif

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

struct RecordingSink final : public ps_sync_http::StreamSessionSink {
  std::vector<std::string> steps;
  std::vector<std::string> chunks;
  std::string last_error;
  std::string last_fail;
  int last_status = 0;
  std::string last_status_text;
  std::string last_content_type;
  int dropped = 0;
  std::function<void()> on_headers_hook;
  std::function<void()> on_cancel_hook;

  void OnHeaders(int status, const std::string& status_text,
                 const std::string& content_type) override {
    last_status = status;
    last_status_text = status_text;
    last_content_type = content_type;
    steps.emplace_back("headers");
    if (on_headers_hook) {
      auto hook = std::move(on_headers_hook);
      hook();
    }
  }

  void OnFail(const std::string& message) override {
    last_fail = message;
    steps.emplace_back("fail:" + message);
  }

  void OnData(const std::string& utf8_chunk) override {
    chunks.push_back(utf8_chunk);
    steps.emplace_back("data:" + utf8_chunk);
  }

  void OnError(const std::string& message) override {
    last_error = message;
    steps.emplace_back("error:" + message);
  }

  void OnEnd() override { steps.emplace_back("end"); }

  void CancelIo() override {
    steps.emplace_back("cancel_io");
    if (on_cancel_hook) {
      auto hook = std::move(on_cancel_hook);
      hook();
    }
  }

  void OnDrop() override {
    dropped += 1;
    steps.emplace_back("drop");
  }
};

std::string joined(const std::vector<std::string>& steps) {
  std::string out;
  for (size_t i = 0; i < steps.size(); ++i) {
    if (i > 0) {
      out += ",";
    }
    out += steps[i];
  }
  return out;
}

void expect_steps(const RecordingSink& sink, const char* want, const char* what) {
  const std::string got = joined(sink.steps);
  if (got != want) {
    std::fprintf(stderr, "FAIL: %s got [%s] want [%s]\n", what, got.c_str(), want);
    ++g_failures;
    return;
  }
  std::printf("ok: %s\n", what);
}

void push_str(ps_sync_http::SyncHttpStreamSession& session, const std::string& s,
              ps_sync_http::StreamSessionSink& sink) {
  session.OnBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size(), sink);
}

size_t hold_raw(const uint8_t* bytes, size_t len) {
  return ps_sync_http::TrailingIncompleteUtf8Bytes(bytes, len);
}

}  // namespace

int main() {
  // 1. Route predicate.
  expect(ps_sync_http::Route(false, true) == PS_SYNC_HTTP_ROUTE_IDLE,
         "route: non-stream URL is idle-complete even with a sender");
  expect(ps_sync_http::Route(true, false) == PS_SYNC_HTTP_ROUTE_IDLE,
         "route: /sync/stream without a sender is idle-complete");
  expect(ps_sync_http::Route(true, true) == PS_SYNC_HTTP_ROUTE_STREAMING,
         "route: /sync/stream + sender is streamingId");
  expect(ps_sync_http::Route(false, false) == PS_SYNC_HTTP_ROUTE_IDLE,
         "route: neither flag is idle-complete");

  // 2. Pre-headers failure -> fail Callback + drop, zero events, idempotent.
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    session.OnError("connect reset", sink);
    expect_steps(sink, "fail:connect reset,drop",
                 "pre-headers onError emits fail Callback + drop");
    expect(session.IsTerminal(), "pre-headers onError claims terminal");
    sink.steps.clear();
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    push_str(session, "ignored", sink);
    session.OnError("second", sink);
    session.OnEnd(sink);
    expect_steps(sink, "", "post-terminal steps are ignored");
  }

  // 3. Happy path: headers -> bytes -> clean EOF -> drop.
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    push_str(session, "before-headers", sink);
    expect_steps(sink, "", "bytes before headers are ignored");
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    push_str(session, "{\"a\":1}\n", sink);
    push_str(session, "{\"b\":2}\n", sink);
    session.OnEnd(sink);
    expect_steps(sink, "headers,data:{\"a\":1}\n,data:{\"b\":2}\n,end,drop",
                 "happy path: headers + onData* + onEnd + drop");
    expect(sink.last_status == 200 && sink.last_status_text == "OK" &&
               sink.last_content_type == "application/x-ndjson",
           "headers metadata forwarded to sink");
    sink.steps.clear();
    push_str(session, "late", sink);
    session.OnEnd(sink);
    expect_steps(sink, "", "late bytes/end after onEnd are ignored");
  }

  // 4. Error after headers: flushes non-aborted carry, then onError + onEnd + drop.
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    const uint8_t partial_euro[] = {'x', 0xe2, 0x82};
    session.OnBytes(partial_euro, sizeof(partial_euro), sink);
    expect_steps(sink, "headers,data:x", "incomplete euro tail held in carry");
    session.OnError("", sink);
    expect(sink.steps.size() == 6 && sink.steps[2].rfind("data:", 0) == 0 &&
               sink.steps[3] == "error:httpFetch stream failed" &&
               sink.steps[4] == "end" && sink.steps[5] == "drop",
           "non-aborted onError flushes carry and uses default error message");
    expect(sink.dropped == 1, "error after headers drops once");
  }

  // 5. Abort before headers: cancels I/O, ignores late headers, fail Callback on I/O error.
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    session.Abort(sink);
    expect_steps(sink, "cancel_io", "abort before headers only cancels I/O");
    sink.steps.clear();
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    expect_steps(sink, "", "late headers after abort are ignored");
    session.OnError("", sink);
    expect_steps(sink, "fail:aborted,drop",
                 "I/O onError after abort before headers emits aborted fail Callback");
  }

  // 6. Abort after headers: cancels I/O, drops incomplete UTF-8 carry, emits onError + onEnd.
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    const uint8_t partial_euro[] = {'a', 0xe2};
    session.OnBytes(partial_euro, sizeof(partial_euro), sink);
    sink.steps.clear();
    session.Abort(sink);
    expect_steps(sink, "cancel_io", "abort after headers only cancels I/O");
    sink.steps.clear();
    session.OnEnd(sink);
    expect_steps(sink, "error:aborted,end,drop",
                 "onEnd after abort drops carry and emits onError(aborted) + onEnd");
  }

  // 7. Re-entrant abort inside OnHeaders with synchronous CancelIo -> OnError (no deadlock).
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    sink.on_cancel_hook = [&]() { session.OnError(PS_SYNC_HTTP_ABORT_MESSAGE, sink); };
    sink.on_headers_hook = [&]() { session.Abort(sink); };
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    expect_steps(sink, "headers,cancel_io,error:aborted,end,drop",
                 "re-entrant abort inside OnHeaders with synchronous CancelIo does not deadlock");
  }

  // 8. UTF-8 trailing-incomplete rules (1..4 byte sequences, all-continuation, invalid lead).
  {
    expect(hold_raw(nullptr, 4) == 0, "utf8 hold: null pointer holds 0");
    expect(hold_raw(reinterpret_cast<const uint8_t*>(""), 0) == 0, "utf8 hold: empty holds 0");
    expect(hold_raw(reinterpret_cast<const uint8_t*>("ascii\n"), 6) == 0,
           "utf8 hold: ascii holds 0");

    const uint8_t two[] = {0xc3, 0xa9};
    expect(hold_raw(two, 1) == 1 && hold_raw(two, 2) == 0, "utf8 hold: 2-byte sequence");

    const uint8_t three[] = {0xe2, 0x82, 0xac};
    expect(hold_raw(three, 1) == 1 && hold_raw(three, 2) == 2 && hold_raw(three, 3) == 0,
           "utf8 hold: 3-byte sequence");

    const uint8_t four[] = {0xf0, 0x9f, 0x92, 0xa9};
    expect(hold_raw(four, 1) == 1 && hold_raw(four, 2) == 2 && hold_raw(four, 3) == 3 &&
               hold_raw(four, 4) == 0,
           "utf8 hold: 4-byte sequence");

    const uint8_t only_cont[] = {0x80, 0x80};
    expect(hold_raw(only_cont, 2) == 2, "utf8 hold: all-continuation holds len");

    const uint8_t invalid_lead[] = {0xff};
    expect(hold_raw(invalid_lead, 1) == 0, "utf8 hold: invalid lead holds 0");
  }

  // 9. Shared fixture catalog: split-multibyte reassembly through SyncHttpStreamSession.
  try {
    const auto catalog = ps_sync_fixtures::load_path(PS_SYNC_STREAM_FIXTURES_PATH);
    const auto* split = ps_sync_fixtures::find_scenario(catalog, "split-multibyte");
    expect(split != nullptr, "split-multibyte scenario present");
    if (split != nullptr) {
      const auto wire = ps_sync_fixtures::wire_chunks(*split);
      expect(wire.size() == 2, "split-multibyte has two wire pieces");
      ps_sync_http::SyncHttpStreamSession session;
      RecordingSink sink;
      session.OnHeaders(200, "OK", catalog.content_type, sink);
      for (const auto& piece : wire) {
        push_str(session, piece, sink);
      }
      session.OnEnd(sink);
      expect(sink.chunks == split->chunks,
             "SyncHttpStreamSession reassembles split-multibyte into exact fixture chunks");
      expect(sink.steps.back() == "drop" && sink.steps[sink.steps.size() - 2] == "end",
             "split-multibyte ends cleanly with onEnd + drop");
    }
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: fixture: %s\n", ex.what());
    return 1;
  }

  // 10. Concurrent Abort while OnBytes streams (smoke race check).
  {
    ps_sync_http::SyncHttpStreamSession session;
    RecordingSink sink;
    session.OnHeaders(200, "OK", "application/x-ndjson", sink);
    std::thread aborter([&]() { session.Abort(sink); });
    for (int i = 0; i < 16; ++i) {
      push_str(session, "chunk\n", sink);
    }
    aborter.join();
    session.OnError(PS_SYNC_HTTP_ABORT_MESSAGE, sink);
    expect(sink.dropped == 1 && !sink.last_error.empty(),
           "concurrent abort + bytes terminates cleanly and drops once");
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "%d sync-http-session check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all shared SyncHttpStreamSession checks passed\n");
  return 0;
}
