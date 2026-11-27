#ifndef POWERSYNC_LYNX_SYNC_HTTP_SESSION_H_
#define POWERSYNC_LYNX_SYNC_HTTP_SESSION_H_

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "sync_http_policy.h"

/** Route: streaming only when the URL is /sync/stream and a sender exists. */
#define PS_SYNC_HTTP_ROUTE_IDLE 0
#define PS_SYNC_HTTP_ROUTE_STREAMING 1

/** Pre-headers / I/O failure envelope defaults. JS reads `ok` + `message`. */
#define PS_SYNC_HTTP_FAIL_STATUS (-1)
#define PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT "httpFetch stream failed"
#define PS_SYNC_HTTP_ABORT_MESSAGE "aborted"

namespace ps_sync_http {

/**
 * Routing predicate for Native Module HTTP (ADR-0003).
 * Streaming (`streamingId` + GlobalEventEmitter) is selected only when the URL
 * is `/sync/stream` and an event sender is registered; otherwise idle-complete.
 */
int Route(bool is_sync_stream_url, bool has_event_sender);

/**
 * Returns how many trailing bytes do not form a complete UTF-8 sequence, so
 * those bytes stay buffered across native chunk boundaries and PrimJS only
 * receives well-formed UTF-8 strings.
 *
 * Matches `trailingIncompleteUtf8Bytes` in `src/sync/transport/bytes.ts`
 * (pinned by `shared/fixtures/sync-stream.json` scenario `split-multibyte`).
 */
size_t TrailingIncompleteUtf8Bytes(const uint8_t* bytes, size_t len);

/**
 * Incomplete UTF-8 carry buffer backed by `TrailingIncompleteUtf8Bytes`.
 */
class Utf8ChunkBuffer {
 public:
  std::string Push(const uint8_t* data, size_t len);
  std::string Flush();

 private:
  std::vector<uint8_t> carry_;
};

/**
 * Host sink driven by `SyncHttpStreamSession`.
 *
 * All callbacks are invoked with `SyncHttpStreamSession`'s internal state lock
 * released, and all non-cancel callbacks are serialized in exact protocol order
 * (`OnHeaders` -> `OnData`* -> `OnError`? -> `OnEnd` -> `OnDrop`, or pre-headers
 * `OnFail` -> `OnDrop`). `CancelIo` is invoked with zero locks held so I/O
 * cancellation can safely re-enter `OnError`/`OnEnd`.
 */
struct StreamSessionSink {
  virtual ~StreamSessionSink() = default;
  virtual void OnHeaders(int status, const std::string& status_text,
                         const std::string& content_type) = 0;
  virtual void OnFail(const std::string& message) = 0;
  virtual void OnData(const std::string& utf8_chunk) = 0;
  virtual void OnError(const std::string& message) = 0;
  virtual void OnEnd() = 0;
  virtual void CancelIo() = 0;
  virtual void OnDrop() = 0;
};

/**
 * Deep stream-session module for NativeSyncHttp (ADR-0003).
 *
 * Owns state transitions (`headers_sent`, `terminal`, `aborted`), incomplete
 * UTF-8 carry buffering and flush rules, error message defaults, and serialized
 * effect delivery across Android JNI, iOS, macOS, and Windows.
 */
class SyncHttpStreamSession {
 public:
  SyncHttpStreamSession() = default;
  SyncHttpStreamSession(const SyncHttpStreamSession&) = delete;
  SyncHttpStreamSession& operator=(const SyncHttpStreamSession&) = delete;

  void OnHeaders(int status, const std::string& status_text,
                 const std::string& content_type, StreamSessionSink& sink);

  void OnBytes(const uint8_t* data, size_t len, StreamSessionSink& sink);

  void OnEnd(StreamSessionSink& sink);

  void OnError(const std::string& message, StreamSessionSink& sink);

  void Abort(StreamSessionSink& sink);

  bool IsTerminal() const;

 private:
  mutable std::mutex state_mutex_;
  std::recursive_mutex emit_mutex_;
  bool headers_sent_ = false;
  bool terminal_ = false;
  bool aborted_ = false;
  Utf8ChunkBuffer utf8_buf_;
};

}  // namespace ps_sync_http

#endif  // POWERSYNC_LYNX_SYNC_HTTP_SESSION_H_
