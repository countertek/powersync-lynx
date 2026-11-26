#ifndef POWERSYNC_LYNX_DESKTOP_SYNC_HTTP_H_
#define POWERSYNC_LYNX_DESKTOP_SYNC_HTTP_H_

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

namespace ps_desktop_http {

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

using EnvelopeCallback = std::function<void(HttpResponseEnvelope)>;
using StreamEventSender = std::function<void(const StreamEvent&)>;

/**
 * Incomplete UTF-8 carry buffer backed by shared/utf8_hold.h.
 * Holds trailing incomplete multi-byte sequences across chunk boundaries so
 * PrimJS only receives well-formed UTF-8 strings on GlobalEventEmitter.
 */
class Utf8ChunkBuffer {
 public:
  std::string Push(const uint8_t* data, size_t len);
  std::string Flush();

 private:
  std::vector<uint8_t> carry_;
};

std::string Base64Encode(const uint8_t* data, size_t len);

HttpResponseEnvelope MakeFailEnvelope(const std::string& message);
HttpResponseEnvelope MakeIdleErrorEnvelope(int status, const std::string& message);
HttpResponseEnvelope MakeIdleSuccessEnvelope(int status,
                                             const std::string& status_text,
                                             const std::vector<uint8_t>& bytes,
                                             const std::string& content_type,
                                             bool idle_complete);

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

// Platform-specific HTTP backends (desktop_sync_http_macos.mm / desktop_sync_http_win.cc).
std::shared_ptr<PlatformStreamTask> StartPlatformStreamingRequest(
    const HttpRequest& request, PlatformStreamCallbacks callbacks);

void StartPlatformIdleCompleteRequest(const HttpRequest& request,
                                      bool is_sync_stream,
                                      EnvelopeCallback callback);

class DesktopSyncHttp {
 public:
  DesktopSyncHttp() = default;
  DesktopSyncHttp(const DesktopSyncHttp&) = delete;
  DesktopSyncHttp& operator=(const DesktopSyncHttp&) = delete;

  void SetSharedStreamEventSender(StreamEventSender sender);

  void Fetch(HttpRequest request, StreamEventSender event_sender,
             EnvelopeCallback callback);

  void Abort(const std::string& stream_id, std::function<void()> callback);

 private:
  struct StreamHandle {
    ps_sync_http_session session;
    std::string stream_id;
    EnvelopeCallback callback;
    StreamEventSender sender;
    std::mutex emit_mutex;
    Utf8ChunkBuffer utf8_buf;
    std::mutex task_mutex;
    std::shared_ptr<PlatformStreamTask> task;
    bool cancel_requested = false;
  };

  void ApplyEffects(const std::shared_ptr<StreamHandle>& handle, int effects,
                    int status, const std::string& status_text,
                    const std::string& content_type, const std::string& data,
                    const std::string& error);

  StreamEventSender ResolveEventSender(StreamEventSender per_call_sender);

  std::mutex shared_sender_mutex_;
  StreamEventSender shared_sender_;

  std::mutex active_streams_mutex_;
  std::unordered_map<std::string, std::shared_ptr<StreamHandle>> active_streams_;
  std::atomic<long> stream_counter_{0};
};

DesktopSyncHttp& SharedDesktopSyncHttp();

}  // namespace ps_desktop_http

#endif  // POWERSYNC_LYNX_DESKTOP_SYNC_HTTP_H_
