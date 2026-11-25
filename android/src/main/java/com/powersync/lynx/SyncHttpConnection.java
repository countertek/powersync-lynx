package com.powersync.lynx;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Shared {@link HttpURLConnection} setup and response-header normalization for
 * {@link IdleCompleteHttp} and {@link StreamingHttp}.
 */
final class SyncHttpConnection {
  private SyncHttpConnection() {}

  static HttpURLConnection open(
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

  static Map<String, String> flattenHeaders(Map<String, List<String>> fields) {
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
