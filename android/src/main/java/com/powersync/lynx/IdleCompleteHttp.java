package com.powersync.lynx;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Idle-complete HTTP for PowerSync {@code /sync/stream}.
 *
 * <p>Fallback when no GlobalEventEmitter sender is reachable. Reads until EOF or a short idle
 * read timeout after bytes have arrived. Timeouts match {@code shared/sync_http_policy.h}
 * ({@code PS_SYNC_HTTP_IDLE_COMPLETE_MS} / {@code PS_SYNC_HTTP_CONNECT_TIMEOUT_MS}).
 */
final class IdleCompleteHttp {
  /** Keep in lockstep with {@code PS_SYNC_HTTP_IDLE_COMPLETE_MS}. */
  static final long IDLE_READ_TIMEOUT_MS = 2_500L;
  /** Keep in lockstep with {@code PS_SYNC_HTTP_CONNECT_TIMEOUT_MS}. */
  static final long CONNECT_TIMEOUT_MS = 30_000L;
  /** Keep in lockstep with {@code PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS}. */
  static final long BUFFERED_READ_TIMEOUT_MS = 30_000L;

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
    String httpMethod = method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.US);
    boolean idle = isSyncStreamUrl(url);
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout((int) CONNECT_TIMEOUT_MS);
    conn.setReadTimeout(idle ? (int) IDLE_READ_TIMEOUT_MS : (int) BUFFERED_READ_TIMEOUT_MS);
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

    int status;
    try {
      status = conn.getResponseCode();
    } catch (SocketTimeoutException firstByteIdle) {
      // No response line within the idle window.
      throw firstByteIdle;
    }
    String statusText = conn.getResponseMessage();
    Map<String, String> responseHeaders = flattenHeaders(conn.getHeaderFields());
    InputStream stream =
        status >= HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
    byte[] responseBody = readUntilIdleOrEof(stream, idle || looksLikeLongLived(responseHeaders));
    return new Result(status, statusText, responseHeaders, responseBody);
  }

  static boolean isSyncStreamUrl(String url) {
    return url != null && url.toLowerCase(Locale.US).contains("/sync/stream");
  }

  static boolean looksLikeLongLived(Map<String, String> headers) {
    if (headers == null) {
      return false;
    }
    String encoding = header(headers, "transfer-encoding");
    if (encoding != null && encoding.toLowerCase(Locale.US).contains("chunked")) {
      return header(headers, "content-length") == null;
    }
    String contentType = header(headers, "content-type");
    if (contentType == null) {
      return false;
    }
    String lower = contentType.toLowerCase(Locale.US);
    return lower.contains("ndjson")
        || lower.contains("bson-stream")
        || lower.contains("text/event-stream");
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

  private static String header(Map<String, String> headers, String name) {
    for (Map.Entry<String, String> entry : headers.entrySet()) {
      if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) {
        return entry.getValue();
      }
    }
    return null;
  }
}
