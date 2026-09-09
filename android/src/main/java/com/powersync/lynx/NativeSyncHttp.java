package com.powersync.lynx;

import androidx.annotation.Nullable;
import com.lynx.jsbridge.Arguments;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.JavaOnlyArray;
import com.lynx.react.bridge.JavaOnlyMap;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.ReadableType;
import com.lynx.react.bridge.WritableMap;
import com.lynx.tasm.behavior.LynxContext;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Native Module HTTP for {@code /sync/stream}. Autolink still registers methods on
 * {@link NativePowerSyncModule}; this class is the SQL/HTTP boundary.
 *
 * <p>Primary: {@code streamingId} + GlobalEventEmitter {@code onData*} → {@code onError?} → {@code
 * onEnd}. Idle-complete UTF-8 body is fallback when {@link LynxContext} is absent.
 *
 * <p>Timeouts and URL heuristics match {@code shared/sync_http_policy.h}.
 */
final class NativeSyncHttp {
  /** Keep in lockstep with {@code PS_SYNC_HTTP_STREAM_EVENT_PREFIX}. */
  static final String STREAM_EVENT_PREFIX = "NativePowerSyncHttpStream";

  interface ContextSource {
    @Nullable
    LynxContext lynxContext();
  }

  private static final class StreamHandle {
    final AtomicBoolean cancelled = new AtomicBoolean(false);
    final AtomicReference<HttpURLConnection> connection = new AtomicReference<>();
  }

  private final ContextSource contextSource;
  private final ExecutorService executor;
  private final Map<String, StreamHandle> activeStreams = new ConcurrentHashMap<>();
  private final AtomicLong nextStreamId = new AtomicLong(0);

  NativeSyncHttp(ContextSource contextSource, ExecutorService executor) {
    this.contextSource = contextSource;
    this.executor = executor;
  }

  void fetch(ReadableMap request, Callback callback) {
    ParsedHttpRequest parsed = parseHttpRequest(request);
    if (parsed.error != null) {
      invoke(callback, fail(parsed.error));
      return;
    }
    if (IdleCompleteHttp.isSyncStreamUrl(parsed.url) && contextSource.lynxContext() != null) {
      executor.execute(() -> fetchStreaming(parsed, callback));
      return;
    }
    executor.execute(() -> invoke(callback, fetchIdleComplete(parsed)));
  }

  void abort(String streamId, Callback callback) {
    StreamHandle handle = streamId == null ? null : activeStreams.get(streamId);
    if (handle != null) {
      handle.cancelled.set(true);
      HttpURLConnection conn = handle.connection.get();
      if (conn != null) {
        try {
          conn.disconnect();
        } catch (Throwable ignored) {
          // disconnect is best-effort; the reader loop still observes cancelled.
        }
      }
    }
    WritableMap ok = Arguments.createMap();
    ok.putBoolean("ok", true);
    invoke(callback, ok);
  }

  private void fetchStreaming(ParsedHttpRequest parsed, Callback callback) {
    final String streamId = STREAM_EVENT_PREFIX + nextStreamId.getAndIncrement();
    final StreamHandle handle = new StreamHandle();
    activeStreams.put(streamId, handle);
    final AtomicBoolean headersSent = new AtomicBoolean(false);
    try {
      StreamingHttp.stream(
          parsed.method,
          parsed.url,
          parsed.headers,
          parsed.bodyBytes,
          handle.cancelled,
          handle.connection,
          new StreamingHttp.Listener() {
            @Override
            public void onHeaders(int status, String statusText, String contentType) {
              if (!headersSent.compareAndSet(false, true)) {
                return;
              }
              WritableMap ok = Arguments.createMap();
              ok.putBoolean("ok", true);
              ok.putDouble("status", status);
              ok.putString("statusText", statusText == null ? "" : statusText);
              if (contentType != null) {
                ok.putString("contentType", contentType);
              }
              ok.putString("body", "");
              ok.putString("streamingId", streamId);
              ok.putBoolean("idleComplete", false);
              invoke(callback, ok);
            }

            @Override
            public void onData(String utf8Chunk) {
              if (utf8Chunk == null || utf8Chunk.isEmpty()) {
                return;
              }
              sendStreamEvent(streamId, "onData", utf8Chunk, null);
            }

            @Override
            public void onEnd() {
              sendStreamEvent(streamId, "onEnd", null, null);
              activeStreams.remove(streamId);
            }

            @Override
            public void onError(String message) {
              emitTerminalError(streamId, headersSent.get(), callback, message);
              activeStreams.remove(streamId);
            }
          });
    } catch (Throwable t) {
      activeStreams.remove(streamId);
      emitTerminalError(
          streamId,
          headersSent.get(),
          callback,
          t.getMessage() != null ? t.getMessage() : "httpFetch failed");
    }
  }

  /**
   * After headers: {@code onError} then {@code onEnd}. Before headers: one-shot callback failure
   * (no GlobalEventEmitter events).
   */
  private void emitTerminalError(
      String streamId, boolean headersSent, Callback callback, String message) {
    String text = message != null ? message : "httpFetch stream failed";
    if (!headersSent) {
      invoke(callback, fail(text));
      return;
    }
    sendStreamEvent(streamId, "onError", null, text);
    sendStreamEvent(streamId, "onEnd", null, null);
  }

  private WritableMap fetchIdleComplete(ParsedHttpRequest parsed) {
    try {
      IdleCompleteHttp.Result result =
          IdleCompleteHttp.fetch(parsed.method, parsed.url, parsed.headers, parsed.bodyBytes);
      WritableMap ok = Arguments.createMap();
      ok.putBoolean("ok", true);
      ok.putDouble("status", result.status);
      ok.putString("statusText", result.statusText);
      String contentType = result.headers.get("content-type");
      if (contentType != null) {
        ok.putString("contentType", contentType);
      }
      String bodyText = IdleCompleteHttp.utf8(result.body);
      ok.putString("body", bodyText);
      ok.putString(
          "bodyBase64",
          android.util.Base64.encodeToString(result.body, android.util.Base64.NO_WRAP));
      ok.putBoolean("idleComplete", IdleCompleteHttp.isSyncStreamUrl(parsed.url));
      return ok;
    } catch (Throwable t) {
      return fail(t.getMessage() != null ? t.getMessage() : "httpFetch failed");
    }
  }

  static final class ParsedHttpRequest {
    final String url;
    final String method;
    final Map<String, String> headers;
    final byte[] bodyBytes;
    final String error;

    ParsedHttpRequest(
        String url, String method, Map<String, String> headers, byte[] bodyBytes, String error) {
      this.url = url;
      this.method = method;
      this.headers = headers;
      this.bodyBytes = bodyBytes;
      this.error = error;
    }
  }

  static ParsedHttpRequest parseHttpRequest(ReadableMap request) {
    if (request == null || !request.hasKey("url") || request.isNull("url")) {
      return new ParsedHttpRequest(null, null, null, null, "url is required");
    }
    String url = request.getString("url");
    if (url == null || url.isEmpty()) {
      return new ParsedHttpRequest(null, null, null, null, "url is required");
    }
    String method =
        request.hasKey("method") && !request.isNull("method") ? request.getString("method") : "GET";
    Map<String, String> headers = new java.util.LinkedHashMap<>();
    if (request.hasKey("headers") && !request.isNull("headers")) {
      ReadableMap headerMap = request.getMap("headers");
      if (headerMap != null) {
        for (Map.Entry<String, Object> entry : headerMap.asHashMap().entrySet()) {
          if (entry.getKey() != null && entry.getValue() != null) {
            headers.put(entry.getKey(), String.valueOf(entry.getValue()));
          }
        }
      }
    }
    byte[] bodyBytes = null;
    if (request.hasKey("body") && !request.isNull("body")) {
      ReadableType bodyType = request.getType("body");
      if (bodyType == ReadableType.String) {
        bodyBytes = request.getString("body").getBytes(StandardCharsets.UTF_8);
      } else if (bodyType == ReadableType.ByteArray) {
        bodyBytes = request.getByteArray("body");
      }
    }
    return new ParsedHttpRequest(url, method, headers, bodyBytes, null);
  }

  private void sendStreamEvent(String streamId, String event, String data, String error) {
    LynxContext context = contextSource.lynxContext();
    if (context == null) {
      return;
    }
    JavaOnlyMap payload = new JavaOnlyMap();
    payload.putString("event", event);
    if (data != null) {
      payload.putString("data", data);
    }
    if (error != null) {
      payload.putString("error", error);
    }
    JavaOnlyArray params = new JavaOnlyArray();
    params.pushMap(payload);
    context.sendGlobalEvent(streamId, params);
  }

  private static WritableMap fail(String message) {
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", false);
    map.putString("message", message != null ? message : "native error");
    return map;
  }

  private static void invoke(Callback callback, WritableMap envelope) {
    if (callback != null) {
      callback.invoke(envelope);
    }
  }
}
