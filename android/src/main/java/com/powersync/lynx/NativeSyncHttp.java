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
 * {@link NativePowerSyncModule}; this class is the SQL/HTTP seam.
 *
 * <p>Stream state transitions, UTF-8 chunk framing, and ordered effect delivery live in
 * {@link SyncHttpSession} ({@code shared/sync_http/sync_http_session.{h,cc}}). Timeouts and
 * stream event names come from {@link SyncHttpPolicy} ({@code shared/sync_http_policy.h}).
 *
 * <p>Primary: {@code streamingId} + GlobalEventEmitter {@code onData*} → {@code onError?} →
 * {@code onEnd}. Idle-complete UTF-8 body is fallback when {@link LynxContext} is absent.
 */
final class NativeSyncHttp {
  interface ContextSource {
    @Nullable
    LynxContext lynxContext();
  }

  private final class StreamHandle implements SyncHttpSession.Sink {
    final String streamId;
    final Callback callback;
    final AtomicBoolean cancelled = new AtomicBoolean(false);
    final AtomicReference<HttpURLConnection> connection = new AtomicReference<>();
    final SyncHttpSession session = new SyncHttpSession();

    StreamHandle(String streamId, Callback callback) {
      this.streamId = streamId;
      this.callback = callback;
    }

    @Override
    public void onHeaders(int status, String statusText, @Nullable String contentType) {
      WritableMap ok = Arguments.createMap();
      ok.putBoolean("ok", true);
      ok.putDouble("status", status);
      ok.putString("statusText", statusText == null ? "" : statusText);
      if (contentType != null && !contentType.isEmpty()) {
        ok.putString("contentType", contentType);
      }
      ok.putString("body", "");
      ok.putString("streamingId", streamId);
      ok.putBoolean("idleComplete", false);
      invoke(callback, ok);
    }

    @Override
    public void onFail(String message) {
      invoke(callback, fail(message));
    }

    @Override
    public void onData(String utf8Chunk) {
      sendStreamEvent(streamId, SyncHttpPolicy.EVENT_ON_DATA, utf8Chunk, null);
    }

    @Override
    public void onError(String message) {
      sendStreamEvent(streamId, SyncHttpPolicy.EVENT_ON_ERROR, null, message);
    }

    @Override
    public void onEnd() {
      sendStreamEvent(streamId, SyncHttpPolicy.EVENT_ON_END, null, null);
    }

    @Override
    public void cancelIo() {
      cancelled.set(true);
      HttpURLConnection conn = connection.get();
      if (conn != null) {
        try {
          conn.disconnect();
        } catch (Throwable ignored) {
          // disconnect is best-effort; the reader loop still observes cancelled.
        }
      }
    }

    @Override
    public void onDrop() {
      activeStreams.remove(streamId, this);
    }
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
    boolean streaming =
        SyncHttpSession.route(
                SyncHttpSession.isSyncStreamUrl(parsed.url), contextSource.lynxContext() != null)
            == SyncHttpSession.ROUTE_STREAMING;
    if (streaming) {
      executor.execute(() -> fetchStreaming(parsed, callback));
      return;
    }
    executor.execute(() -> invoke(callback, fetchIdleComplete(parsed)));
  }

  void abort(String streamId, Callback callback) {
    StreamHandle handle = streamId == null ? null : activeStreams.get(streamId);
    if (handle != null) {
      handle.session.abort(handle);
    }
    WritableMap ok = Arguments.createMap();
    ok.putBoolean("ok", true);
    invoke(callback, ok);
  }

  private void fetchStreaming(ParsedHttpRequest parsed, Callback callback) {
    final String streamId = SyncHttpPolicy.STREAM_EVENT_PREFIX + nextStreamId.getAndIncrement();
    final StreamHandle handle = new StreamHandle(streamId, callback);
    activeStreams.put(streamId, handle);
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
              handle.session.onHeaders(status, statusText, contentType, handle);
            }

            @Override
            public void onBytes(byte[] bytes, int offset, int length) {
              handle.session.onBytes(bytes, offset, length, handle);
            }

            @Override
            public void onEnd() {
              handle.session.onEnd(handle);
            }

            @Override
            public void onError(String message) {
              handle.session.onError(message, handle);
            }
          });
    } catch (Throwable t) {
      handle.session.onError(t.getMessage(), handle);
    } finally {
      activeStreams.remove(streamId, handle);
      handle.session.close();
    }
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
      ok.putBoolean("idleComplete", SyncHttpSession.isSyncStreamUrl(parsed.url));
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

  private static final String PS_FAIL_DEFAULT = "httpFetch stream failed";

  /** Shared pre-headers failure envelope ({@code shared/sync_http/sync_http_session.h}). */
  private static WritableMap fail(String message) {
    String text = message != null && !message.isEmpty() ? message : PS_FAIL_DEFAULT;
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", false);
    map.putDouble("status", SyncHttpSession.FAIL_STATUS);
    map.putString("statusText", "");
    map.putString("message", text);
    map.putString("body", text);
    map.putBoolean("idleComplete", false);
    return map;
  }

  private static void invoke(Callback callback, WritableMap envelope) {
    if (callback != null) {
      callback.invoke(envelope);
    }
  }
}
