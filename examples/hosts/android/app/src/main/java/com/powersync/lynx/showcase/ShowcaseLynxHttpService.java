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
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
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
 * Lynx HTTP service for Connector / JSON traffic.
 *
 * <p>{@code /sync/stream} downloads go through Native Module HTTP ({@code httpFetch} + {@code
 * streamingId}), not this service. Stock {@code LynxHttpService} {@code ResponseBody.bytes()} would
 * hang on a live NDJSON connection; this host therefore does not idle-complete sync streams.
 */
@Keep
public final class ShowcaseLynxHttpService implements ILynxHttpService {
  private static final String TAG = "ShowcaseLynxHttp";
  private static final int CODE_FAILED_INTERNALLY = 499;
  private static final String DEPRECATED_STREAMING_FLAG = "useStreaming";

  /** Ordinary JSON Connector / token fetches. Keep in lockstep with {@code PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS}. */
  static final long BUFFERED_READ_TIMEOUT_MS = 30_000L;

  /** Streaming keepalive. Keep in lockstep with {@code PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS}. */
  static final long STREAMING_READ_TIMEOUT_MS = 120_000L;

  private static final ShowcaseLynxHttpService INSTANCE = new ShowcaseLynxHttpService();

  private final OkHttpClient bufferedClient;
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
            .readTimeout(STREAMING_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build());
  }

  ShowcaseLynxHttpService(OkHttpClient bufferedClient, OkHttpClient streamingClient) {
    this.bufferedClient = bufferedClient;
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
    OkHttpClient client = delegate != null ? streamingClient : bufferedClient;

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
                    byte[] bytes = new byte[0];
                    ResponseBody body = response.body();
                    if (body != null) {
                      try {
                        bytes = body.bytes();
                      } catch (IOException readError) {
                        Log.w(TAG, "buffered read failed: " + readError);
                        httpResponse.setStatusCode(CODE_FAILED_INTERNALLY);
                        httpResponse.setStatusText(String.valueOf(readError));
                      }
                    }
                    httpResponse.setHttpBody(bytes);
                    callback.invoke(httpResponse);
                    return;
                  }

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
}
