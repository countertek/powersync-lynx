package com.powersync.lynx;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Incremental HTTP for PowerSync {@code /sync/stream}.
 *
 * <p>Keeps the chunked NDJSON connection open and forwards raw socket bytes into
 * {@link SyncHttpSession} ({@code shared/sync_http/sync_http_session.{h,cc}}), which owns
 * incomplete UTF-8 carry buffering and terminal event sequencing ({@code onData*} →
 * {@code onError?} → {@code onEnd}).
 *
 * <p>Read timeout is {@link SyncHttpPolicy#STREAM_READ_TIMEOUT_MS} so keepalive gaps do not abort.
 */
final class StreamingHttp {
  interface Listener {
    void onHeaders(int status, String statusText, String contentType);

    void onBytes(byte[] bytes, int offset, int length);

    void onEnd();

    void onError(String message);
  }

  private StreamingHttp() {}

  static void stream(
      String method,
      String url,
      Map<String, String> headers,
      byte[] body,
      AtomicBoolean cancelled,
      AtomicReference<HttpURLConnection> bound,
      Listener listener)
      throws IOException {
    HttpURLConnection conn =
        SyncHttpConnection.open(
            method,
            url,
            headers,
            body,
            (int) SyncHttpPolicy.CONNECT_TIMEOUT_MS,
            (int) SyncHttpPolicy.STREAM_READ_TIMEOUT_MS,
            bound);

    if (cancelled.get()) {
      conn.disconnect();
      listener.onError("aborted");
      return;
    }

    int status;
    try {
      status = conn.getResponseCode();
    } catch (IOException first) {
      conn.disconnect();
      if (cancelled.get()) {
        listener.onError("aborted");
        return;
      }
      throw first;
    }
    String statusText = conn.getResponseMessage();
    Map<String, String> responseHeaders =
        SyncHttpConnection.flattenHeaders(conn.getHeaderFields());
    String contentType = responseHeaders.get("content-type");
    listener.onHeaders(status, statusText == null ? "" : statusText, contentType);

    InputStream stream =
        status >= HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
    if (stream == null) {
      conn.disconnect();
      listener.onEnd();
      return;
    }

    byte[] chunk = new byte[8192];
    try (InputStream in = stream) {
      while (!cancelled.get()) {
        int n;
        try {
          n = in.read(chunk);
        } catch (SocketTimeoutException idle) {
          if (cancelled.get()) {
            listener.onError("aborted");
          } else {
            listener.onEnd();
          }
          return;
        } catch (IOException io) {
          if (cancelled.get()) {
            listener.onError("aborted");
            return;
          }
          throw io;
        }
        if (n < 0) {
          if (cancelled.get()) {
            listener.onError("aborted");
            return;
          }
          listener.onEnd();
          return;
        }
        if (n > 0) {
          listener.onBytes(chunk, 0, n);
        }
      }
      listener.onError("aborted");
    } finally {
      conn.disconnect();
    }
  }

  private static final int HTTP_BAD_REQUEST = 400;
}
