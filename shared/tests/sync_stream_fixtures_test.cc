#include "sync_stream_fixtures.h"
#include "ndjson_http_replay.h"

#include <cstdio>
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

}  // namespace

int main() {
  using ps_sync_fixtures::Catalog;
  using ps_sync_fixtures::NdjsonReplayServer;
  using ps_sync_fixtures::ReplayConfig;
  using ps_sync_fixtures::find_scenario;
  using ps_sync_fixtures::has_key;
  using ps_sync_fixtures::http_get_body;
  using ps_sync_fixtures::incremental_data_before_end;
  using ps_sync_fixtures::joined_body;
  using ps_sync_fixtures::load_default;
  using ps_sync_fixtures::valid_terminal_sequence;

  Catalog catalog;
  try {
    catalog = load_default();
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: load fixtures: %s\n", ex.what());
    return 1;
  }
  expect(catalog.content_type == "application/x-ndjson", "contentType is application/x-ndjson");
  expect(has_key(catalog.idle_complete_keys, "body"), "idle-complete envelope has body");
  expect(has_key(catalog.idle_complete_keys, "bodyBase64"),
         "idle-complete envelope has bodyBase64");
  expect(has_key(catalog.idle_complete_keys, "idleComplete"),
         "idle-complete envelope has idleComplete");
  expect(!has_key(catalog.idle_complete_keys, "streamingId"),
         "idle-complete fallback envelope has no streamingId key");
  expect(has_key(catalog.streaming_keys, "streamingId"), "streaming envelope has streamingId");
  expect(has_key(catalog.streaming_keys, "idleComplete"),
         "streaming envelope has idleComplete=false");
  expect(has_key(catalog.streaming_keys, "body"), "streaming envelope has empty body key");

  const auto* checkpoint = find_scenario(catalog, "checkpoint-ops");
  expect(checkpoint != nullptr, "checkpoint-ops scenario present");
  if (checkpoint != nullptr) {
    expect(checkpoint->path == ps_sync_fixtures::kPathStreamingId,
           "checkpoint-ops is the streamingId path");
    expect(checkpoint->chunks.size() == 2, "checkpoint-ops has checkpoint + ops chunks");
    expect(checkpoint->chunks[0].find("\"checkpoint\"") != std::string::npos,
           "first chunk is a checkpoint line");
    expect(checkpoint->chunks[1].find("\"data\"") != std::string::npos,
           "second chunk is a data/ops line");
    expect(valid_terminal_sequence(checkpoint->events),
           "checkpoint-ops events are onData* → onEnd");
    expect(incremental_data_before_end(checkpoint->events),
           "checkpoint-ops delivers onData before onEnd");
    expect(checkpoint->events.size() == 3 && checkpoint->events[0] == PS_SYNC_HTTP_EVENT_ON_DATA &&
               checkpoint->events[1] == PS_SYNC_HTTP_EVENT_ON_DATA &&
               checkpoint->events[2] == PS_SYNC_HTTP_EVENT_ON_END,
           "checkpoint-ops is two onData then onEnd");
  }

  const auto* errored = find_scenario(catalog, "error-then-end");
  expect(errored != nullptr, "error-then-end scenario present");
  if (errored != nullptr) {
    expect(errored->path == ps_sync_fixtures::kPathStreamingId,
           "error-then-end is the streamingId path");
    expect(!errored->error.empty(), "error-then-end carries an error string");
    expect(valid_terminal_sequence(errored->events),
           "error-then-end events are onData* → onError → onEnd");
    expect(errored->events.size() >= 3 &&
               errored->events[errored->events.size() - 2] == PS_SYNC_HTTP_EVENT_ON_ERROR &&
               errored->events.back() == PS_SYNC_HTTP_EVENT_ON_END,
           "onError is immediately followed by onEnd (B terminal alignment)");
  }

  const auto* idle = find_scenario(catalog, "idle-complete");
  expect(idle != nullptr, "idle-complete scenario present");
  if (idle != nullptr) {
    expect(idle->path == ps_sync_fixtures::kPathIdleComplete, "idle-complete path");
    expect(idle->events.empty(), "idle-complete has no GlobalEventEmitter events");
    expect(!joined_body(*idle).empty(), "idle-complete body is UTF-8 NDJSON");
  }

  const std::vector<std::string> android_old_error_only = {PS_SYNC_HTTP_EVENT_ON_ERROR};
  expect(!valid_terminal_sequence(android_old_error_only),
         "onError without onEnd is invalid (pre-B Android asymmetry)");
  const std::vector<std::string> end_then_error = {PS_SYNC_HTTP_EVENT_ON_DATA,
                                                   PS_SYNC_HTTP_EVENT_ON_END,
                                                   PS_SYNC_HTTP_EVENT_ON_ERROR};
  expect(!valid_terminal_sequence(end_then_error), "onEnd then onError is invalid");

  if (checkpoint != nullptr) {
    NdjsonReplayServer server;
    ReplayConfig config;
    config.content_type = catalog.content_type;
    config.chunks = checkpoint->chunks;
    expect(server.start(config), "loopback NDJSON server starts");
    std::string body;
    int status = 0;
    expect(http_get_body(server.url(), &body, &status), "POSIX client fetches fixture stream");
    expect(status == 200, "fixture HTTP status 200");
    expect(body == joined_body(*checkpoint), "loopback body matches checkpoint-ops NDJSON");
    server.stop();
  }

  expect(PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS == 120000,
         "streaming idle/read gap is 120s (not a total lifetime)");
  expect(PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS == 0,
         "streaming resource lifetime is platform default, not STREAM_READ+CONNECT");
  expect(PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS == 30000,
         "idle-complete buffered read timeout stays 30s");

  if (g_failures != 0) {
    std::fprintf(stderr, "%d sync-stream fixture check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all shared NDJSON stream fixture checks passed\n");
  return 0;
}
