package com.powersync.lynx;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Idle-complete HTTP for PowerSync {@code /sync/stream}.
 *
 * <p>Fallback when no GlobalEventEmitter sender is reachable. Reads until EOF or a short idle
 * read timeout after bytes have arrived. Timeouts come from {@link SyncHttpPolicy}
 * ({@code shared/sync_http_policy.h}).
 */
final class IdleCompleteHttp {
  private IdleCompleteHttp() {}

  static final class Result {
    final int status;
    final String statusText;
    final Map<String, String> headers;
    final byte[] body;

    Result(int status, String statusText, Map<String, String> headers, byte[] body) {
      this.status = status;
      this.statusText = statusText == null ? "" : statusText;
      this.headers = headers;
      this.body = body == null ? new byte[0] : body;
    }
  }

  static Result fetch(String method, String url, Map<String, String> headers, byte[] body)
      throws IOException {
    boolean idle = SyncHttpSession.isSyncStreamUrl(url);
    HttpURLConnection conn =
        SyncHttpConnection.open(
            method,
            url,
            headers,
            body,
            (int) SyncHttpPolicy.CONNECT_TIMEOUT_MS,
            idle
                ? (int) SyncHttpPolicy.IDLE_COMPLETE_MS
                : (int) SyncHttpPolicy.BUFFERED_READ_TIMEOUT_MS,
            null);

    int status;
    try {
      status = conn.getResponseCode();
    } catch (SocketTimeoutException firstByteIdle) {
      // No response line within the idle window.
      throw firstByteIdle;
    }
    String statusText = conn.getResponseMessage();
    Map<String, String> responseHeaders =
        SyncHttpConnection.flattenHeaders(conn.getHeaderFields());
    InputStream stream =
        status >= HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
    byte[] responseBody = readUntilIdleOrEof(stream, idle || looksLikeLongLived(responseHeaders));
    return new Result(status, statusText, responseHeaders, responseBody);
  }

  static boolean looksLikeLongLived(Map<String, String> headers) {
    if (headers == null) {
      return false;
    }
    return SyncHttpSession.looksLikeLongLived(
        header(headers, "transfer-encoding"),
        header(headers, "content-length"),
        header(headers, "content-type"));
  }

  static byte[] readUntilIdleOrEof(InputStream in, boolean longLived) throws IOException {
    if (in == null) {
      return new byte[0];
    }
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    try (InputStream stream = in) {
      while (true) {
        int n;
        try {
          n = stream.read(chunk);
        } catch (SocketTimeoutException idle) {
          if (longLived && buffer.size() > 0) {
            return buffer.toByteArray();
          }
          throw idle;
        }
        if (n < 0) {
          break;
        }
        buffer.write(chunk, 0, n);
      }
    }
    return buffer.toByteArray();
  }

  static String utf8(byte[] bytes) {
    return new String(bytes == null ? new byte[0] : bytes, StandardCharsets.UTF_8);
  }

  private static final int HTTP_BAD_REQUEST = 400;

  private static String header(Map<String, String> headers, String name) {
    for (Map.Entry<String, String> entry : headers.entrySet()) {
      if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) {
        return entry.getValue();
      }
    }
    return null;
  }
}
