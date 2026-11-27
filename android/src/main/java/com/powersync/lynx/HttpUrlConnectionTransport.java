package com.powersync.lynx;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Production Android {@link NativeSyncHttp.HttpTransport} adapter backed by
 * {@link HttpURLConnection}.
 *
 * <p>Owns connection setup, header normalization, streaming chunk reads, opaque cancellation, and
 * idle-complete read timeout lowering after the first body byte arrives ({@link SyncHttpPolicy}).
 */
final class HttpUrlConnectionTransport implements NativeSyncHttp.HttpTransport {
  private static final int HTTP_BAD_REQUEST = 400;

  @Override
  public void stream(
      NativeSyncHttp.ParsedHttpRequest request,
      NativeSyncHttp.StreamCallbacks callbacks,
      Consumer<NativeSyncHttp.CancelHandle> onCancelHandle)
      throws IOException {
    final AtomicBoolean cancelled = new AtomicBoolean(false);
    final AtomicReference<HttpURLConnection> bound = new AtomicReference<>();
    onCancelHandle.accept(
        () -> {
          cancelled.set(true);
          HttpURLConnection conn = bound.get();
          if (conn != null) {
            try {
              conn.disconnect();
            } catch (Throwable ignored) {
              // disconnect is best-effort; the reader loop also checks cancelled.
            }
          }
        });

    if (cancelled.get()) {
      callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
      return;
    }

    HttpURLConnection conn =
        openConnection(
            request.method,
            request.url,
            request.headers,
            request.bodyBytes,
            (int) SyncHttpPolicy.CONNECT_TIMEOUT_MS,
            (int) SyncHttpPolicy.STREAM_READ_TIMEOUT_MS,
            bound);

    if (cancelled.get()) {
      conn.disconnect();
      callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
      return;
    }

    int status;
    try {
      status = conn.getResponseCode();
    } catch (IOException first) {
      conn.disconnect();
      if (cancelled.get()) {
        callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
        return;
      }
      throw first;
    }
    String statusText = conn.getResponseMessage();
    Map<String, String> responseHeaders = flattenHeaders(conn.getHeaderFields());
    String contentType = responseHeaders.get("content-type");
    callbacks.onHeaders(status, statusText == null ? "" : statusText, contentType);

    InputStream stream =
        status >= HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
    if (stream == null) {
      conn.disconnect();
      callbacks.onEnd();
      return;
    }

    byte[] chunk = new byte[8192];
    try (InputStream in = stream) {
      while (!cancelled.get()) {
        int n;
        try {
          n = in.read(chunk);
        } catch (SocketTimeoutException timeout) {
          callbacks.onError(
              cancelled.get()
                  ? SyncHttpPolicy.ABORT_MESSAGE
                  : (timeout.getMessage() != null
                      ? timeout.getMessage()
                      : "stream read timeout"));
          return;
        } catch (IOException io) {
          if (cancelled.get()) {
            callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
            return;
          }
          throw io;
        }
        if (n < 0) {
          if (cancelled.get()) {
            callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
            return;
          }
          callbacks.onEnd();
          return;
        }
        if (n > 0) {
          callbacks.onBytes(chunk, 0, n);
        }
      }
      callbacks.onError(SyncHttpPolicy.ABORT_MESSAGE);
    } finally {
      conn.disconnect();
    }
  }

  @Override
  public NativeSyncHttp.IdleOutcome fetchIdleComplete(
      NativeSyncHttp.ParsedHttpRequest request, boolean isSyncStream) throws IOException {
    // Use BUFFERED_READ_TIMEOUT_MS until the first body byte arrives; only then lower to
    // IDLE_COMPLETE_MS for long-lived streams (shared/sync_http_policy.h).
    HttpURLConnection conn =
        openConnection(
            request.method,
            request.url,
            request.headers,
            request.bodyBytes,
            (int) SyncHttpPolicy.CONNECT_TIMEOUT_MS,
            (int) SyncHttpPolicy.BUFFERED_READ_TIMEOUT_MS,
            null);
    try {
      int status = conn.getResponseCode();
      String statusText = conn.getResponseMessage();
      Map<String, String> responseHeaders = flattenHeaders(conn.getHeaderFields());
      String contentType = responseHeaders.get("content-type");
      boolean longLived =
          isSyncStream
              || SyncHttpSession.looksLikeLongLived(
                  responseHeaders.get("transfer-encoding"),
                  responseHeaders.get("content-length"),
                  contentType);
      InputStream stream =
          status >= HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
      if (stream == null) {
        return new NativeSyncHttp.IdleOutcome(
            status, statusText, contentType, new byte[0], false, null);
      }
      ByteArrayOutputStream buffer = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      boolean loweredIdleTimeout = false;
      boolean idleTimedOut = false;
      try (InputStream in = stream) {
        while (true) {
          int n;
          try {
            n = in.read(chunk);
          } catch (SocketTimeoutException idle) {
            if (longLived && buffer.size() > 0) {
              idleTimedOut = true;
              break;
            }
            throw idle;
          }
          if (n < 0) {
            break;
          }
          if (n > 0) {
            buffer.write(chunk, 0, n);
            if (longLived && !loweredIdleTimeout) {
              loweredIdleTimeout = true;
              conn.setReadTimeout((int) SyncHttpPolicy.IDLE_COMPLETE_MS);
            }
          }
        }
      }
      return new NativeSyncHttp.IdleOutcome(
          status, statusText, contentType, buffer.toByteArray(), idleTimedOut, null);
    } finally {
      conn.disconnect();
    }
  }

  private static HttpURLConnection openConnection(
      String method,
      String url,
      Map<String, String> headers,
      byte[] body,
      int connectTimeoutMs,
      int readTimeoutMs,
      AtomicReference<HttpURLConnection> bound)
      throws IOException {
    String httpMethod = method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.US);
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    if (bound != null) {
      bound.set(conn);
    }
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout(connectTimeoutMs);
    conn.setReadTimeout(readTimeoutMs);
    conn.setRequestMethod(httpMethod);
    conn.setUseCaches(false);
    if (headers != null) {
      for (Map.Entry<String, String> entry : headers.entrySet()) {
        if (entry.getKey() != null && entry.getValue() != null) {
          conn.setRequestProperty(entry.getKey(), entry.getValue());
        }
      }
    }
    if (!"GET".equals(httpMethod) && !"HEAD".equals(httpMethod)) {
      conn.setDoOutput(true);
      byte[] payload = body == null ? new byte[0] : body;
      conn.setFixedLengthStreamingMode(payload.length);
      try (OutputStream out = conn.getOutputStream()) {
        out.write(payload);
      }
    }
    return conn;
  }

  private static Map<String, String> flattenHeaders(Map<String, List<String>> fields) {
    Map<String, String> out = new LinkedHashMap<>();
    if (fields == null) {
      return out;
    }
    for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
      if (entry.getKey() == null || entry.getValue() == null || entry.getValue().isEmpty()) {
        continue;
      }
      out.put(entry.getKey().toLowerCase(Locale.US), String.join(", ", entry.getValue()));
    }
    return out;
  }
}
