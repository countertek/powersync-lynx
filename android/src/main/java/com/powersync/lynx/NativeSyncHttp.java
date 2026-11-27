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
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Native Module HTTP seam for Android (ADR-0003).
 *
 * <p>Registered on {@link NativePowerSyncModule} for Lynx Autolink packaging, but kept out of the
 * SQL RPC module ({@link PsSqlEngine}). Owns request parsing, {@code streamingId} lifecycle,
 * idle-complete envelope construction, and {@link SyncHttpSession} wiring over an injectable
 * {@link HttpTransport} seam.
 */
final class NativeSyncHttp {
  interface ContextSource {
    @Nullable
    LynxContext lynxContext();
  }

  interface CancelHandle {
    void cancel();
  }

  interface StreamCallbacks {
    void onHeaders(int status, String statusText, @Nullable String contentType);

    void onBytes(byte[] bytes, int offset, int length);

    void onEnd();

    void onError(@Nullable String message);
  }

  static final class IdleOutcome {
    final int status;
    final String statusText;
    @Nullable final String contentType;
    final byte[] body;
    final boolean idleTimedOut;
    @Nullable final String error;

    IdleOutcome(
        int status,
        @Nullable String statusText,
        @Nullable String contentType,
        @Nullable byte[] body,
        boolean idleTimedOut,
        @Nullable String error) {
      this.status = status;
      this.statusText = statusText == null ? "" : statusText;
      this.contentType = contentType;
      this.body = body == null ? new byte[0] : body;
      this.idleTimedOut = idleTimedOut;
      this.error = error;
    }
  }

  interface HttpTransport {
    void stream(
        ParsedHttpRequest request,
        StreamCallbacks callbacks,
        Consumer<CancelHandle> onCancelHandle)
        throws IOException;

    IdleOutcome fetchIdleComplete(ParsedHttpRequest request, boolean isSyncStream)
        throws IOException;
  }

  interface Session extends AutoCloseable {
    void onHeaders(int status, String statusText, @Nullable String contentType, SyncHttpSession.Sink sink);

    void onBytes(byte[] bytes, int offset, int length, SyncHttpSession.Sink sink);

    void onEnd(SyncHttpSession.Sink sink);

    void onError(@Nullable String message, SyncHttpSession.Sink sink);

    void abort(SyncHttpSession.Sink sink);

    @Override
    void close();
  }

  interface SessionFactory {
    boolean isSyncStreamUrl(String url);

    int route(boolean syncStreamUrl, boolean hasEventSender);

    Session create();
  }

  interface Base64Encoder {
    String encode(byte[] bytes);
  }

  private static final SessionFactory JNI_SESSION_FACTORY =
      new SessionFactory() {
        @Override
        public boolean isSyncStreamUrl(String url) {
          return SyncHttpSession.isSyncStreamUrl(url);
        }

        @Override
        public int route(boolean syncStreamUrl, boolean hasEventSender) {
          return SyncHttpSession.route(syncStreamUrl, hasEventSender);
        }

        @Override
        public Session create() {
          return new SyncHttpSession();
        }
      };

  private static final Base64Encoder ANDROID_BASE64 =
      bytes -> android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);

  private final class StreamHandle implements SyncHttpSession.Sink {
    final String streamId;
    final Callback callback;
    final Session session;
    private final Object cancelLock = new Object();
    @Nullable private CancelHandle cancelHandle;
    private boolean cancelRequested;

    StreamHandle(String streamId, Callback callback, Session session) {
      this.streamId = streamId;
      this.callback = callback;
      this.session = session;
    }

    void bindCancelHandle(CancelHandle handle) {
      boolean shouldCancel;
      synchronized (cancelLock) {
        cancelHandle = handle;
        shouldCancel = cancelRequested;
      }
      if (shouldCancel) {
        handle.cancel();
      }
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
      CancelHandle toCancel;
      synchronized (cancelLock) {
        cancelRequested = true;
        toCancel = cancelHandle;
      }
      if (toCancel != null) {
        toCancel.cancel();
      }
    }

    @Override
    public void onDrop() {
      activeStreams.remove(streamId, this);
    }
  }

  private final ContextSource contextSource;
  private final ExecutorService executor;
  private final HttpTransport transport;
  private final SessionFactory sessionFactory;
  private final Base64Encoder base64Encoder;
  private final Map<String, StreamHandle> activeStreams = new ConcurrentHashMap<>();
  private final AtomicLong nextStreamId = new AtomicLong(0);

  NativeSyncHttp(ContextSource contextSource, ExecutorService executor) {
    this(
        contextSource,
        executor,
        new HttpUrlConnectionTransport(),
        JNI_SESSION_FACTORY,
        ANDROID_BASE64);
  }

  NativeSyncHttp(
      ContextSource contextSource,
      ExecutorService executor,
      HttpTransport transport,
      SessionFactory sessionFactory,
      Base64Encoder base64Encoder) {
    this.contextSource = contextSource;
    this.executor = executor;
    this.transport = transport;
    this.sessionFactory = sessionFactory;
    this.base64Encoder = base64Encoder;
  }

  void fetch(ReadableMap request, Callback callback) {
    ParsedHttpRequest parsed = parseHttpRequest(request);
    if (parsed.error != null) {
      invoke(callback, fail(parsed.error));
      return;
    }
    boolean isSyncStream = sessionFactory.isSyncStreamUrl(parsed.url);
    boolean streaming =
        sessionFactory.route(isSyncStream, contextSource.lynxContext() != null)
            == (int) SyncHttpPolicy.ROUTE_STREAMING;
    if (streaming) {
      executor.execute(() -> fetchStreaming(parsed, callback));
      return;
    }
    executor.execute(() -> invoke(callback, fetchIdleComplete(parsed, isSyncStream)));
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
    final Session session = sessionFactory.create();
    final StreamHandle handle = new StreamHandle(streamId, callback, session);
    activeStreams.put(streamId, handle);
    try {
      transport.stream(
          parsed,
          new StreamCallbacks() {
            @Override
            public void onHeaders(int status, String statusText, @Nullable String contentType) {
              session.onHeaders(status, statusText, contentType, handle);
            }

            @Override
            public void onBytes(byte[] bytes, int offset, int length) {
              session.onBytes(bytes, offset, length, handle);
            }

            @Override
            public void onEnd() {
              session.onEnd(handle);
            }

            @Override
            public void onError(@Nullable String message) {
              session.onError(message, handle);
            }
          },
          handle::bindCancelHandle);
    } catch (Throwable t) {
      session.onError(t.getMessage(), handle);
    } finally {
      activeStreams.remove(streamId, handle);
      session.close();
    }
  }

  private WritableMap fetchIdleComplete(ParsedHttpRequest parsed, boolean isSyncStream) {
    try {
      IdleOutcome outcome = transport.fetchIdleComplete(parsed, isSyncStream);
      if (outcome.error != null && !outcome.error.isEmpty() && outcome.body.length == 0) {
        return fail(outcome.error);
      }
      WritableMap ok = Arguments.createMap();
      ok.putBoolean("ok", true);
      ok.putDouble("status", outcome.status);
      ok.putString("statusText", outcome.statusText);
      if (outcome.contentType != null && !outcome.contentType.isEmpty()) {
        ok.putString("contentType", outcome.contentType);
      }
      ok.putString("body", new String(outcome.body, StandardCharsets.UTF_8));
      ok.putString("bodyBase64", base64Encoder.encode(outcome.body));
      boolean idleComplete = isSyncStream && (outcome.idleTimedOut || outcome.error == null);
      ok.putBoolean("idleComplete", idleComplete);
      return ok;
    } catch (Throwable t) {
      return fail(t.getMessage() != null ? t.getMessage() : SyncHttpPolicy.FAIL_MESSAGE_DEFAULT);
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

  /** Shared pre-headers failure envelope ({@code shared/sync_http_policy.h}). */
  private static WritableMap fail(String message) {
    String text =
        message != null && !message.isEmpty() ? message : SyncHttpPolicy.FAIL_MESSAGE_DEFAULT;
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", false);
    map.putDouble("status", (double) SyncHttpPolicy.FAIL_STATUS);
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
