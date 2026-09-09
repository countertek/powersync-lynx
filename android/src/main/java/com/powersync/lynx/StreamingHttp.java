package com.powersync.lynx;

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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Incremental HTTP for PowerSync {@code /sync/stream}.
 *
 * <p>Keeps the chunked NDJSON connection open and delivers UTF-8 string chunks as they arrive.
 * Unlike {@link IdleCompleteHttp}, this does <strong>not</strong> close after a short idle window —
 * PowerSync keepalive (~20s) and later checkpoints stay on the same session.
 *
 * <p>Read timeout is long (120s) so keepalive gaps do not abort; stock {@code ResponseBody.bytes()}
 * is never called.
 */
final class StreamingHttp {
  static final long CONNECT_TIMEOUT_MS = 30_000L;
  /** Longer than PowerSync protocol keepalive (~20s). */
  static final long STREAM_READ_TIMEOUT_MS = 120_000L;

  interface Listener {
    void onHeaders(int status, String statusText, String contentType);

    void onData(String utf8Chunk);

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
      Listener listener)
      throws IOException {
    String httpMethod = method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.US);
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout((int) CONNECT_TIMEOUT_MS);
    conn.setReadTimeout((int) STREAM_READ_TIMEOUT_MS);
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
      throw first;
    }
    String statusText = conn.getResponseMessage();
    Map<String, String> responseHeaders = flattenHeaders(conn.getHeaderFields());
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
    // Carry incomplete UTF-8 so PrimJS always receives well-formed string chunks.
    byte[] carry = new byte[0];
    try (InputStream in = stream) {
      while (!cancelled.get()) {
        int n;
        try {
          n = in.read(chunk);
        } catch (SocketTimeoutException idle) {
          // Long silence after bytes — keep waiting (timeout resets per read). Treat pure
          // first-byte timeout with no prior data as end; otherwise continue is not possible
          // because the read already failed. Disconnect and end so PowerSync can reconnect.
          listener.onEnd();
          return;
        }
        if (n < 0) {
          if (carry.length > 0) {
            listener.onData(new String(carry, StandardCharsets.UTF_8));
            carry = new byte[0];
          }
          listener.onEnd();
          return;
        }
        byte[] combined = new byte[carry.length + n];
        System.arraycopy(carry, 0, combined, 0, carry.length);
        System.arraycopy(chunk, 0, combined, carry.length, n);
        int hold = trailingIncompleteUtf8Bytes(combined);
        int complete = combined.length - hold;
        if (complete > 0) {
          listener.onData(new String(combined, 0, complete, StandardCharsets.UTF_8));
        }
        if (hold > 0) {
          carry = new byte[hold];
          System.arraycopy(combined, complete, carry, 0, hold);
        } else {
          carry = new byte[0];
        }
      }
      listener.onError("aborted");
    } finally {
      conn.disconnect();
    }
  }

  /** Same incomplete-UTF-8 hold as LynxRemote.createLynxTextDecoder. */
  static int trailingIncompleteUtf8Bytes(byte[] bytes) {
    if (bytes == null || bytes.length == 0) {
      return 0;
    }
    int i = bytes.length - 1;
    int continuation = 0;
    while (i >= 0 && (bytes[i] & 0xc0) == 0x80) {
      continuation++;
      i--;
    }
    if (i < 0) {
      return bytes.length;
    }
    int lead = bytes[i] & 0xff;
    int expected;
    if ((lead & 0x80) == 0) {
      expected = 0;
    } else if ((lead & 0xe0) == 0xc0) {
      expected = 1;
    } else if ((lead & 0xf0) == 0xe0) {
      expected = 2;
    } else if ((lead & 0xf8) == 0xf0) {
      expected = 3;
    } else {
      return 0;
    }
    if (continuation < expected) {
      return continuation + 1;
    }
    return 0;
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
}
