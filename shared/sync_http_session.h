#pragma once

/**
 * NativeSyncHttp stream-session contract (FM-PS-LYNX-014 N3 / ADR-0003).
 *
 * Hosts keep platform HTTP (HttpURLConnection / NSURLSession) and emit Lynx
 * Callback + GlobalEventEmitter maps. This header owns the decisions:
 *   - idle-complete vs streamingId route
 *   - headers-sent (one-shot callback)
 *   - terminal emission (onData* → onError? → onEnd)
 *   - abort-after-headers (cancel I/O; I/O on_error drives the terminal)
 *
 * Host I/O callbacks (onHeaders / onData / onEnd / onError / abort) call the
 * step functions and apply the returned effect bits. Desktop N-API must not
 * include this file (SQL-only).
 *
 * Requires C++ (`std::atomic`). iOS .mm includes it; Android JNI wraps it.
 */

#ifndef __cplusplus
#error "sync_http_session.h requires C++"
#endif

#include <atomic>

#include "sync_http_policy.h"

/** Route: streaming only when the URL is /sync/stream and a sender exists. */
#define PS_SYNC_HTTP_ROUTE_IDLE 0
#define PS_SYNC_HTTP_ROUTE_STREAMING 1

/** Pre-headers / I/O failure envelope. JS reads `ok` + `message`. */
#define PS_SYNC_HTTP_FAIL_STATUS (-1)
#define PS_SYNC_HTTP_FAIL_MESSAGE_DEFAULT "httpFetch stream failed"
#define PS_SYNC_HTTP_ABORT_MESSAGE "aborted"

/**
 * Required keys on a pre-headers failure Callback envelope (hosts may add
 * extras such as iOS idle-complete `bodyBase64` / `contentType`).
 */
#define PS_SYNC_HTTP_FAIL_KEY_OK "ok"
#define PS_SYNC_HTTP_FAIL_KEY_STATUS "status"
#define PS_SYNC_HTTP_FAIL_KEY_STATUS_TEXT "statusText"
#define PS_SYNC_HTTP_FAIL_KEY_MESSAGE "message"
#define PS_SYNC_HTTP_FAIL_KEY_BODY "body"
#define PS_SYNC_HTTP_FAIL_KEY_IDLE_COMPLETE "idleComplete"

/** Bitmask returned by session steps. Hosts apply bits; they do not re-decide. */
#define PS_SYNC_HTTP_EFFECT_NONE 0
#define PS_SYNC_HTTP_EFFECT_CALLBACK_HEADERS (1 << 0)
#define PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL (1 << 1)
#define PS_SYNC_HTTP_EFFECT_EVENT_DATA (1 << 2)
#define PS_SYNC_HTTP_EFFECT_EVENT_ERROR (1 << 3)
#define PS_SYNC_HTTP_EFFECT_EVENT_END (1 << 4)
#define PS_SYNC_HTTP_EFFECT_CANCEL_IO (1 << 5)
#define PS_SYNC_HTTP_EFFECT_DROP (1 << 6)

struct ps_sync_http_session {
  std::atomic<int> headers_sent{0};
  std::atomic<int> terminal{0};
  std::atomic<int> aborted{0};
};

struct ps_sync_http_host {
  void* ctx;
  void (*callback_headers)(void* ctx);
  void (*callback_fail)(void* ctx);
  void (*event_data)(void* ctx);
  void (*event_error)(void* ctx);
  void (*event_end)(void* ctx);
  void (*cancel_io)(void* ctx);
  void (*drop)(void* ctx);
};

static inline int ps_sync_http_route(int is_sync_stream_url, int has_event_sender) {
  if (is_sync_stream_url != 0 && has_event_sender != 0) {
    return PS_SYNC_HTTP_ROUTE_STREAMING;
  }
  return PS_SYNC_HTTP_ROUTE_IDLE;
}

static inline void ps_sync_http_session_init(ps_sync_http_session* session) {
  if (session == nullptr) {
    return;
  }
  session->headers_sent.store(0);
  session->terminal.store(0);
  session->aborted.store(0);
}

static inline int ps_sync_http_session_claim_terminal(ps_sync_http_session* session) {
  if (session == nullptr) {
    return 0;
  }
  int expected = 0;
  return session->terminal.compare_exchange_strong(expected, 1) ? 1 : 0;
}

/** One-shot headers Callback. Ignored after abort or a terminal. */
static inline int ps_sync_http_session_on_headers(ps_sync_http_session* session) {
  if (session == nullptr) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  if (session->aborted.load() != 0 || session->terminal.load() != 0) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  int expected = 0;
  if (!session->headers_sent.compare_exchange_strong(expected, 1)) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  return PS_SYNC_HTTP_EFFECT_CALLBACK_HEADERS;
}

/** Incremental onData. Requires headers; ignored after terminal. */
static inline int ps_sync_http_session_on_data(ps_sync_http_session* session) {
  if (session == nullptr) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  if (session->headers_sent.load() == 0 || session->terminal.load() != 0) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  return PS_SYNC_HTTP_EFFECT_EVENT_DATA;
}

/**
 * Clean EOF. After abort, still emit onError then onEnd so JS sees a failure.
 * Before headers: one-shot fail Callback (no GlobalEventEmitter events).
 */
static inline int ps_sync_http_session_on_end(ps_sync_http_session* session) {
  if (!ps_sync_http_session_claim_terminal(session)) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  if (session->headers_sent.load() == 0) {
    return PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL | PS_SYNC_HTTP_EFFECT_DROP;
  }
  if (session->aborted.load() != 0) {
    return PS_SYNC_HTTP_EFFECT_EVENT_ERROR | PS_SYNC_HTTP_EFFECT_EVENT_END |
           PS_SYNC_HTTP_EFFECT_DROP;
  }
  return PS_SYNC_HTTP_EFFECT_EVENT_END | PS_SYNC_HTTP_EFFECT_DROP;
}

/**
 * I/O or abort error. Before headers: fail Callback. After headers:
 * onError then onEnd.
 */
static inline int ps_sync_http_session_on_error(ps_sync_http_session* session) {
  if (!ps_sync_http_session_claim_terminal(session)) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  if (session->headers_sent.load() == 0) {
    return PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL | PS_SYNC_HTTP_EFFECT_DROP;
  }
  return PS_SYNC_HTTP_EFFECT_EVENT_ERROR | PS_SYNC_HTTP_EFFECT_EVENT_END |
         PS_SYNC_HTTP_EFFECT_DROP;
}

/**
 * Mark aborted and ask the host to cancel I/O. Does not emit. The I/O
 * on_error / on_end step emits the terminal. Unknown ids are a host no-op.
 */
static inline int ps_sync_http_session_abort(ps_sync_http_session* session) {
  if (session == nullptr) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  session->aborted.store(1);
  if (session->terminal.load() != 0) {
    return PS_SYNC_HTTP_EFFECT_NONE;
  }
  return PS_SYNC_HTTP_EFFECT_CANCEL_IO;
}

/** Apply effect bits through host callbacks (C++ tests + optional host use). */
static inline void ps_sync_http_dispatch(int effects, const ps_sync_http_host* host) {
  if (host == nullptr || effects == PS_SYNC_HTTP_EFFECT_NONE) {
    return;
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_HEADERS) != 0 &&
      host->callback_headers != nullptr) {
    host->callback_headers(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_CALLBACK_FAIL) != 0 && host->callback_fail != nullptr) {
    host->callback_fail(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_DATA) != 0 && host->event_data != nullptr) {
    host->event_data(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_ERROR) != 0 && host->event_error != nullptr) {
    host->event_error(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_EVENT_END) != 0 && host->event_end != nullptr) {
    host->event_end(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_CANCEL_IO) != 0 && host->cancel_io != nullptr) {
    host->cancel_io(host->ctx);
  }
  if ((effects & PS_SYNC_HTTP_EFFECT_DROP) != 0 && host->drop != nullptr) {
    host->drop(host->ctx);
  }
}
