#pragma once

#include <stddef.h>
#include <string.h>

/**
 * Idle-complete + streaming HTTP policy for PowerSync /sync/stream.
 *
 * Keep Android IdleCompleteHttp.java / StreamingHttp.java constants in
 * lockstep with these values. iOS IdleCompleteHttp.mm / StreamingHttp.mm
 * include this header.
 *
 * Idle-complete is the fallback when no GlobalEventEmitter sender is
 * reachable. The primary path is streamingId + onData / onError / onEnd.
 */

#define PS_SYNC_HTTP_IDLE_COMPLETE_MS 2500
#define PS_SYNC_HTTP_CONNECT_TIMEOUT_MS 30000
#define PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS 30000
/**
 * Idle/read gap for a live streaming session (HttpURLConnection read timeout,
 * NSURLSession timeoutIntervalForRequest). Keepalive (~20s) must not abort.
 *
 * Do not use this (or this + CONNECT) as NSURLSession timeoutIntervalForResource:
 * that timer is the total lifetime of the load. A healthy /sync/stream lives for
 * hours; a 150s resource cap reconnects forever. 0 = leave the platform default
 * (NSURLSession: 7 days). Idle-complete fallback still uses BUFFERED_READ /
 * IDLE_COMPLETE as a total wait — do not change that path.
 */
#define PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS 120000
#define PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS 0
#define PS_SYNC_HTTP_STREAM_EVENT_PREFIX "NativePowerSyncHttpStream"

/** Terminal GlobalEventEmitter sequence after headers: onData* → onError? → onEnd. */
#define PS_SYNC_HTTP_EVENT_ON_DATA "onData"
#define PS_SYNC_HTTP_EVENT_ON_ERROR "onError"
#define PS_SYNC_HTTP_EVENT_ON_END "onEnd"

static inline int ps_sync_http_ci_contains(const char* hay, const char* needle) {
  if (hay == NULL || needle == NULL) {
    return 0;
  }
  const size_t nlen = strlen(needle);
  if (nlen == 0) {
    return 1;
  }
  for (const char* p = hay; *p != '\0'; p++) {
    size_t i = 0;
    while (i < nlen && p[i] != '\0') {
      char a = p[i];
      char b = needle[i];
      if (a >= 'A' && a <= 'Z') {
        a = (char)(a - 'A' + 'a');
      }
      if (b >= 'A' && b <= 'Z') {
        b = (char)(b - 'A' + 'a');
      }
      if (a != b) {
        break;
      }
      i++;
    }
    if (i == nlen) {
      return 1;
    }
    if (p[i] == '\0') {
      break;
    }
  }
  return 0;
}

static inline int ps_sync_http_is_sync_stream_url(const char* url) {
  return ps_sync_http_ci_contains(url, "/sync/stream");
}

/**
 * Chunked NDJSON / SSE / bson-stream without Content-Length stays open after
 * the first checkpoint. Idle-complete may finish on a short read timeout once
 * any bytes have arrived.
 */
static inline int ps_sync_http_looks_like_long_lived(const char* transfer_encoding,
                                                     const char* content_length,
                                                     const char* content_type) {
  if (ps_sync_http_ci_contains(transfer_encoding, "chunked") &&
      (content_length == NULL || content_length[0] == '\0')) {
    return 1;
  }
  if (content_type == NULL) {
    return 0;
  }
  return ps_sync_http_ci_contains(content_type, "ndjson") ||
         ps_sync_http_ci_contains(content_type, "bson-stream") ||
         ps_sync_http_ci_contains(content_type, "text/event-stream");
}
