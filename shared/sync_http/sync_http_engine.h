#ifndef POWERSYNC_LYNX_SYNC_HTTP_ENGINE_H_
#define POWERSYNC_LYNX_SYNC_HTTP_ENGINE_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "sync_http_policy.h"
#include "sync_http_session.h"

namespace ps_sync_http {

struct HttpRequest {
  std::string method;
  std::string url;
  std::vector<std::pair<std::string, std::string>> headers;
  std::string body;
};

struct HttpResponseEnvelope {
  bool ok = false;
  int status = PS_SYNC_HTTP_FAIL_STATUS;
  std::string status_text;
  std::string content_type;
  std::string body;
  std::string body_base64;
  bool has_body_base64 = false;
  std::string message;
  bool idle_complete = false;
  std::string streaming_id;
};

struct StreamEvent {
  std::string stream_id;
  std::string event;  // "onData" | "onError" | "onEnd"
  std::string data;
  std::string error;
};

/**
 * Raw I/O outcome from a buffered / idle-complete platform request.
 * SyncHttpEngine translates this into HttpResponseEnvelope (Base64 + idleComplete policy).
 */
struct IdleHttpOutcome {
  int status = PS_SYNC_HTTP_FAIL_STATUS;
  std::string status_text;
  std::string content_type;
  std::vector<uint8_t> bytes;
  bool idle_timed_out = false;
  std::string error;
};

using EnvelopeCallback = std::function<void(HttpResponseEnvelope)>;
using IdleOutcomeCallback = std::function<void(IdleHttpOutcome)>;
using StreamEventSender = std::function<void(const StreamEvent&)>;

HttpResponseEnvelope MakeFailEnvelope(const std::string& message);

struct PlatformStreamCallbacks {
  std::function<void(int status, const std::string& status_text,
                     const std::string& content_type)>
      on_headers;
  std::function<void(const uint8_t* data, size_t len)> on_bytes;
  std::function<void()> on_end;
  std::function<void(const std::string& error)> on_error;
};

class PlatformStreamTask {
 public:
  virtual ~PlatformStreamTask() = default;
  virtual void Cancel() = 0;
};

/**
 * Internal transport seam for SyncHttpEngine.
 *
 * Production provides two real adapters: Apple NSURLSession (iOS + macOS in
 * `apple_sync_http.mm`) and Windows WinHTTP (`win_sync_http.cc`). Tests may
 * inject an in-memory adapter for deterministic race, lifecycle, and envelope tests.
 */
class PlatformTransport {
 public:
  virtual ~PlatformTransport() = default;

  virtual std::shared_ptr<PlatformStreamTask> StartStreaming(
      const HttpRequest& request, PlatformStreamCallbacks callbacks) = 0;

  virtual void StartIdleComplete(const HttpRequest& request,
                                 bool is_sync_stream,
                                 IdleOutcomeCallback callback) = 0;
};

std::shared_ptr<PlatformTransport> DefaultPlatformTransport();

/**
 * Deep Native Module HTTP engine shared by iOS, macOS, and Windows (ADR-0003).
 *
 * Owns active stream tracking, routing (`streamingId` vs idle-complete),
 * idle-complete envelope & Base64 encoding, `SyncHttpStreamSession` orchestration,
 * and cancellation on `Shutdown()` / destruction without exposing raw `this` to
 * async platform callbacks.
 */
class SyncHttpEngine {
 public:
  explicit SyncHttpEngine(std::shared_ptr<PlatformTransport> transport = nullptr);
  ~SyncHttpEngine();

  SyncHttpEngine(const SyncHttpEngine&) = delete;
  SyncHttpEngine& operator=(const SyncHttpEngine&) = delete;

  void SetSharedStreamEventSender(StreamEventSender sender);
  bool HasSharedStreamEventSender() const;

  void Fetch(HttpRequest request, StreamEventSender event_sender,
             EnvelopeCallback callback);

  void Abort(const std::string& stream_id);

  void Shutdown();

 private:
  struct State;
  struct StreamHandle;

  std::shared_ptr<State> state_;
};

SyncHttpEngine& SharedSyncHttpEngine();

}  // namespace ps_sync_http

#endif  // POWERSYNC_LYNX_SYNC_HTTP_ENGINE_H_
