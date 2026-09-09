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
  using ps_sync_fixtures::http_read_until_close;
  using ps_sync_fixtures::incremental_data_before_end;
  using ps_sync_fixtures::joined_body;
  using ps_sync_fixtures::load_default;
  using ps_sync_fixtures::valid_terminal_sequence;
  using ps_sync_fixtures::wire_chunks;

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
  expect(has_key(catalog.fail_keys, "ok"), "fail envelope has ok");
  expect(has_key(catalog.fail_keys, "status"), "fail envelope has status");
  expect(has_key(catalog.fail_keys, "message"), "fail envelope has message");
  expect(has_key(catalog.fail_keys, "body"), "fail envelope has body");
  expect(has_key(catalog.fail_keys, "idleComplete"), "fail envelope has idleComplete");
  expect(!has_key(catalog.fail_keys, "streamingId"), "fail envelope has no streamingId");

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
    NdjsonReplayServer rst_server;
    ReplayConfig rst;
    rst.content_type = catalog.content_type;
    rst.chunks = errored->chunks;
    rst.rst_after_first_chunk = true;
    expect(rst_server.start(rst), "error-then-end RST loopback server starts");
    std::string rst_raw;
    bool saw_rst = false;
    expect(http_read_until_close(rst_server.url(), &rst_raw, &saw_rst),
           "error-then-end POSIX client reads after first chunk");
    expect(rst_raw.find("HTTP/1.1 200") != std::string::npos,
           "error-then-end RST delivers HTTP 200 headers");
    expect(rst_raw.find(errored->chunks.front()) != std::string::npos,
           "error-then-end RST delivers the first NDJSON chunk before reset");
    rst_server.stop();
  }

  const auto* idle = find_scenario(catalog, "idle-complete");
  expect(idle != nullptr, "idle-complete scenario present");
  if (idle != nullptr) {
    expect(idle->path == ps_sync_fixtures::kPathIdleComplete, "idle-complete path");
    expect(idle->events.empty(), "idle-complete has no GlobalEventEmitter events");
    expect(!joined_body(*idle).empty(), "idle-complete body is UTF-8 NDJSON");
  }

  const auto* split = find_scenario(catalog, "split-multibyte");
  expect(split != nullptr, "split-multibyte scenario present");
  if (split != nullptr) {
    expect(split->path == ps_sync_fixtures::kPathStreamingId, "split-multibyte is streamingId");
    expect(split->wire_chunks_hex.size() == 2, "split-multibyte has wireChunksHex");
    expect(split->chunks.size() == 2, "split-multibyte has well-formed onData chunks");
    expect(valid_terminal_sequence(split->events), "split-multibyte events are onData* → onEnd");
    expect(incremental_data_before_end(split->events),
           "split-multibyte delivers onData before onEnd");
    const auto wire = wire_chunks(*split);
    expect(wire.size() == 2, "split-multibyte decodes two wire pieces");
    std::string joined_wire;
    for (const auto& piece : wire) {
      joined_wire += piece;
    }
    expect(joined_wire == joined_body(*split),
           "split-multibyte wire bytes are the UTF-8 of chunks");
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
