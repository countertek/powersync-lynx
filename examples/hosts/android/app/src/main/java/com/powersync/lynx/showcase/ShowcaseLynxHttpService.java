package com.powersync.lynx.showcase;

import android.util.Log;
import androidx.annotation.Keep;
import androidx.annotation.NonNull;
import com.lynx.jsbridge.network.HttpRequest;
import com.lynx.jsbridge.network.HttpResponse;
import com.lynx.jsbridge.network.HttpStreamingDelegate;
import com.lynx.react.bridge.JavaOnlyMap;
import com.lynx.tasm.service.ILynxHttpService;
import com.lynx.tasm.service.LynxHttpRequestCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Lynx HTTP service that can finish PowerSync {@code /sync/stream} downloads.
 *
 * <p>Stock {@code LynxHttpService} calls {@code ResponseBody.bytes()} on the non-streaming path
 * (when {@code LynxFetchModule} does not pass a streaming delegate). PowerSync keeps that chunked
 * NDJSON connection open after the first checkpoint, so OkHttp's default read timeout fires
 * ({@code SocketTimeoutException} at {@code ResponseBody.bytes()}) and JS never sees body bytes —
 * local {@code ps_buckets} stays 0.
 *
 * <p>This service:
 * <ul>
 *   <li>Non-streaming {@code /sync/stream}: read until EOF <em>or</em> a short idle read timeout,
 *       then return whatever arrived (initial checkpoint + ops).
 *   <li>Streaming: pipe {@code byteStream()} into {@link HttpStreamingDelegate} with a long
 *       read timeout so keepalive gaps do not abort the stream.
 * </ul>
 */
@Keep
public final class ShowcaseLynxHttpService implements ILynxHttpService {
  private static final String TAG = "ShowcaseLynxHttp";
  private static final int CODE_FAILED_INTERNALLY = 499;
  private static final String DEPRECATED_STREAMING_FLAG = "useStreaming";

  /**
   * After the first checkpoint_complete, PowerSync often goes quiet until keepalive (~20s) or the
   * next checkpoint. A short idle window captures the first download batch without waiting for EOF.
   */
  static final long IDLE_READ_TIMEOUT_MS = 2_500L;

  /** Ordinary JSON Connector / token fetches. */
  static final long BUFFERED_READ_TIMEOUT_MS = 30_000L;

  /** Streaming keepalive can exceed OkHttp's default 10s read timeout. */
  static final long STREAMING_READ_TIMEOUT_MS = 120_000L;

  private static final ShowcaseLynxHttpService INSTANCE = new ShowcaseLynxHttpService();

  private final OkHttpClient bufferedClient;
  private final OkHttpClient idleSyncClient;
  private final OkHttpClient streamingClient;

  public static ShowcaseLynxHttpService getInstance() {
    return INSTANCE;
  }

  ShowcaseLynxHttpService() {
    this(
        new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(BUFFERED_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build(),
        new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(IDLE_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build(),
        new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .readTimeout(STREAMING_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build());
  }

  ShowcaseLynxHttpService(
      OkHttpClient bufferedClient, OkHttpClient idleSyncClient, OkHttpClient streamingClient) {
    this.bufferedClient = bufferedClient;
    this.idleSyncClient = idleSyncClient;
    this.streamingClient = streamingClient;
  }

  @Override
  public void request(@NonNull HttpRequest request, @NonNull LynxHttpRequestCallback callback) {
    requestInner(request, callback, null);
  }

  @Override
  public void requestStreaming(
      @NonNull HttpRequest request,
      @NonNull LynxHttpRequestCallback callback,
      @NonNull HttpStreamingDelegate delegate) {
    requestInner(request, callback, delegate);
  }

  private void requestInner(
      HttpRequest request, LynxHttpRequestCallback callback, HttpStreamingDelegate delegate) {
    String url = request.getUrl();
    boolean syncStream = isSyncStreamUrl(url);
    OkHttpClient client;
    if (delegate != null) {
      client = streamingClient;
    } else if (syncStream) {
      client = idleSyncClient;
    } else {
      client = bufferedClient;
    }

    Request okRequest = buildOkRequest(request);
    HttpResponse httpResponse = new HttpResponse();
    httpResponse.setUrl(url);
    httpResponse.setStatusCode(CODE_FAILED_INTERNALLY);

    client
        .newCall(okRequest)
        .enqueue(
            new Callback() {
              @Override
              public void onFailure(@NonNull Call call, @NonNull IOException e) {
                httpResponse.setStatusText(String.valueOf(e));
                callback.invoke(httpResponse);
              }

              @Override
              public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response ignored = response) {
                  JavaOnlyMap httpHeaders = headersToMap(response.headers());
                  httpResponse.setStatusCode(response.code());
                  httpResponse.setStatusText(response.message());
                  httpResponse.setHttpHeaders(httpHeaders);

                  if (delegate == null) {
                    boolean longLived = looksLikeLongLivedStream(url, response);
                    try {
                      httpResponse.setHttpBody(readUntilIdleOrEof(response.body(), longLived, url));
                    } catch (IOException readError) {
                      Log.w(TAG, "buffered read failed: " + readError);
                      httpResponse.setStatusCode(CODE_FAILED_INTERNALLY);
                      httpResponse.setStatusText(String.valueOf(readError));
                      httpResponse.setHttpBody(new byte[0]);
                    }
                    callback.invoke(httpResponse);
                    return;
                  }

                  // Headers/status first so JS receives streamingId before onData.
                  callback.invoke(httpResponse);
                  ResponseBody body = response.body();
                  if (body == null) {
                    delegate.onEnd();
                    return;
                  }
                  try (InputStream inputStream = body.byteStream()) {
                    boolean useDeprecated =
                        request.getCustomConfig() != null
                            && request
                                .getCustomConfig()
                                .getBoolean(DEPRECATED_STREAMING_FLAG, false);
                    if (useDeprecated) {
                      delegate.deprecatedChunkedStreamingBody(inputStream);
                    } else {
                      delegate.streamingBody(inputStream);
                    }
                    delegate.onEnd();
                  } catch (IOException streamError) {
                    Log.w(TAG, "streaming read ended: " + streamError);
                    delegate.onError(String.valueOf(streamError));
                    delegate.onEnd();
                  }
                }
              }
            });
  }

  private static Request buildOkRequest(HttpRequest request) {
    String method = request.getHttpMethod() == null ? "GET" : request.getHttpMethod();
    byte[] bodyBytes = request.getHttpBody();
    RequestBody okBody = null;
    if (!"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method)) {
      // MediaType-first overload is the stable OkHttp 4 Java API.
      okBody =
          RequestBody.create(
              (MediaType) null, bodyBytes == null ? new byte[0] : bodyBytes);
    }

    Headers.Builder headerBuilder = new Headers.Builder();
    JavaOnlyMap headers = request.getHttpHeaders();
    if (headers != null) {
      for (Map.Entry<String, Object> entry : headers.asHashMap().entrySet()) {
        if (entry.getValue() != null) {
          headerBuilder.add(entry.getKey(), String.valueOf(entry.getValue()));
        }
      }
    }

    return new Request.Builder()
        .url(request.getUrl())
        .method(method, okBody)
        .headers(headerBuilder.build())
        .build();
  }

  private static JavaOnlyMap headersToMap(Headers headers) {
    JavaOnlyMap httpHeaders = new JavaOnlyMap();
    Map<String, List<String>> multimap = headers.toMultimap();
    for (Map.Entry<String, List<String>> entry : multimap.entrySet()) {
      httpHeaders.put(entry.getKey(), String.join(", ", entry.getValue()));
    }
    return httpHeaders;
  }

  /**
   * Read a response body without requiring connection EOF. For PowerSync NDJSON streams the
   * server stays open; OkHttp's read timeout then surfaces as {@link SocketTimeoutException},
   * which we treat as end-of-batch when any bytes were already received.
   */
  static byte[] readUntilIdleOrEof(ResponseBody body, boolean longLived, String url)
      throws IOException {
    if (body == null) {
      return new byte[0];
    }
    return readUntilIdleOrEof(body.byteStream(), longLived, url);
  }

  static byte[] readUntilIdleOrEof(InputStream in, boolean longLived, String url)
      throws IOException {
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    try (InputStream stream = in) {
      while (true) {
        int n;
        try {
          n = stream.read(chunk);
        } catch (SocketTimeoutException idle) {
          if (longLived && buffer.size() > 0) {
            Log.i(
                TAG,
                "idle-complete "
                    + url
                    + " bytes="
                    + buffer.size()
                    + " (stock LynxHttpService would hang on ResponseBody.bytes())");
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

  static boolean isSyncStreamUrl(String url) {
    return url != null && url.contains("/sync/stream");
  }

  static boolean looksLikeLongLivedStream(String url, Response response) {
    if (isSyncStreamUrl(url)) {
      return true;
    }
    Map<String, String> headers = new HashMap<>();
    String encoding = response.header("Transfer-Encoding");
    if (encoding != null) {
      headers.put("transfer-encoding", encoding);
    }
    String contentLength = response.header("Content-Length");
    if (contentLength != null) {
      headers.put("content-length", contentLength);
    }
    String contentType = response.header("Content-Type");
    if (contentType != null) {
      headers.put("content-type", contentType);
    }
    return looksLikeLongLivedStream(url, headers);
  }

  /** Header-map overload for host-side unit checks without OkHttp Response. */
  static boolean looksLikeLongLivedStream(String url, Map<String, String> headers) {
    if (isSyncStreamUrl(url)) {
      return true;
    }
    Map<String, String> lower = new HashMap<>();
    if (headers != null) {
      for (Map.Entry<String, String> entry : headers.entrySet()) {
        if (entry.getKey() != null && entry.getValue() != null) {
          lower.put(entry.getKey().toLowerCase(Locale.US), entry.getValue());
        }
      }
    }
    String encoding = lower.get("transfer-encoding");
    if (encoding != null && encoding.toLowerCase(Locale.US).contains("chunked")) {
      return !lower.containsKey("content-length");
    }
    String contentType = lower.get("content-type");
    if (contentType == null) {
      return false;
    }
    String ct = contentType.toLowerCase(Locale.US);
    return ct.contains("ndjson")
        || ct.contains("bson-stream")
        || ct.contains("text/event-stream");
  }
}
