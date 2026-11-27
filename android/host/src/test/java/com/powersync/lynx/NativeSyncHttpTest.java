package com.powersync.lynx;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import androidx.annotation.Nullable;
import com.lynx.react.bridge.Arguments;
import com.lynx.react.bridge.JavaOnlyArray;
import com.lynx.react.bridge.JavaOnlyMap;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.WritableMap;
import com.lynx.tasm.behavior.LynxContext;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.Test;

/**
 * Host JVM tests for {@link NativeSyncHttp} orchestration over an in-memory {@link
 * NativeSyncHttp.HttpTransport} adapter (no Android emulator required).
 */
public class NativeSyncHttpTest {
  private static final class RecordedEvent {
    final String streamId;
    final String event;
    final String data;
    final String error;

    RecordedEvent(String streamId, String event, String data, String error) {
      this.streamId = streamId;
      this.event = event;
      this.data = data;
      this.error = error;
    }
  }

  private static final class FakeLynxContext extends LynxContext {
    final List<RecordedEvent> events = new ArrayList<>();

    FakeLynxContext() {
      super(null);
    }

    @Override
    public void sendGlobalEvent(String name, JavaOnlyArray params) {
      Map<String, Object> payload = ((JavaOnlyMap) params.asList().get(0)).asHashMap();
      events.add(
          new RecordedEvent(
              name,
              (String) payload.get("event"),
              (String) payload.get("data"),
              (String) payload.get("error")));
    }
  }

  /** Lightweight pure-Java state machine matching SyncHttpStreamSession for JVM tests. */
  private static final class FakeSession implements NativeSyncHttp.Session {
    private boolean headersSent;
    private boolean terminal;
    private boolean aborted;

    @Override
    public void onHeaders(
        int status, String statusText, @Nullable String contentType, SyncHttpSession.Sink sink) {
      if (terminal || headersSent) {
        return;
      }
      headersSent = true;
      sink.onHeaders(status, statusText, contentType);
    }

    @Override
    public void onBytes(byte[] bytes, int offset, int length, SyncHttpSession.Sink sink) {
      if (terminal || !headersSent || aborted) {
        return;
      }
      sink.onData(new String(bytes, offset, length, StandardCharsets.UTF_8));
    }

    @Override
    public void onEnd(SyncHttpSession.Sink sink) {
      if (terminal) {
        return;
      }
      terminal = true;
      if (!headersSent) {
        sink.onFail(
            aborted ? SyncHttpPolicy.ABORT_MESSAGE : SyncHttpPolicy.FAIL_MESSAGE_DEFAULT);
      } else {
        if (aborted) {
          sink.onError(SyncHttpPolicy.ABORT_MESSAGE);
        }
        sink.onEnd();
      }
      sink.onDrop();
    }

    @Override
    public void onError(@Nullable String message, SyncHttpSession.Sink sink) {
      if (terminal) {
        return;
      }
      terminal = true;
      String text =
          aborted
              ? SyncHttpPolicy.ABORT_MESSAGE
              : (message != null && !message.isEmpty()
                  ? message
                  : SyncHttpPolicy.FAIL_MESSAGE_DEFAULT);
      if (!headersSent) {
        sink.onFail(text);
      } else {
        sink.onError(text);
        sink.onEnd();
      }
      sink.onDrop();
    }

    @Override
    public void abort(SyncHttpSession.Sink sink) {
      if (terminal || aborted) {
        return;
      }
      aborted = true;
      sink.cancelIo();
    }

    @Override
    public void close() {}
  }

  private static final NativeSyncHttp.SessionFactory FAKE_SESSION_FACTORY =
      new NativeSyncHttp.SessionFactory() {
        @Override
        public boolean isSyncStreamUrl(String url) {
          return url != null && url.toLowerCase(Locale.US).contains("/sync/stream");
        }

        @Override
        public int route(boolean syncStreamUrl, boolean hasEventSender) {
          return (syncStreamUrl && hasEventSender)
              ? (int) SyncHttpPolicy.ROUTE_STREAMING
              : (int) SyncHttpPolicy.ROUTE_IDLE;
        }

        @Override
        public NativeSyncHttp.Session create() {
          return new FakeSession();
        }
      };

  private static final NativeSyncHttp.Base64Encoder JVM_BASE64 =
      bytes -> Base64.getEncoder().encodeToString(bytes);

  private static ExecutorService directExecutor() {
    return Executors.newSingleThreadExecutor();
  }

  private static ReadableMap fetchSync(NativeSyncHttp http, WritableMap request) throws Exception {
    AtomicReference<ReadableMap> result = new AtomicReference<>();
    java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
    http.fetch(
        request,
        args -> {
          result.set((ReadableMap) args[0]);
          latch.countDown();
        });
    assertTrue("callback timed out", latch.await(5, java.util.concurrent.TimeUnit.SECONDS));
    return result.get();
  }

  @Test
  public void missingUrlReturnsFailEnvelopeWithoutInvokingTransport() throws Exception {
    AtomicBoolean called = new AtomicBoolean(false);
    NativeSyncHttp.HttpTransport transport =
        new NativeSyncHttp.HttpTransport() {
          @Override
          public void stream(
              NativeSyncHttp.ParsedHttpRequest req,
              NativeSyncHttp.StreamCallbacks cb,
              Consumer<NativeSyncHttp.CancelHandle> onCancel) {
            called.set(true);
          }

          @Override
          public NativeSyncHttp.IdleOutcome fetchIdleComplete(
              NativeSyncHttp.ParsedHttpRequest req, boolean isSyncStream) {
            called.set(true);
            return new NativeSyncHttp.IdleOutcome(200, "OK", "application/json", new byte[0], false, null);
          }
        };
    ExecutorService exec = directExecutor();
    try {
      NativeSyncHttp http =
          new NativeSyncHttp(() -> null, exec, transport, FAKE_SESSION_FACTORY, JVM_BASE64);
      ReadableMap env = fetchSync(http, Arguments.createMap());
      assertFalse(env.getBoolean("ok"));
      assertEquals((double) SyncHttpPolicy.FAIL_STATUS, env.getDouble("status"), 0.0);
      assertFalse(env.getBoolean("idleComplete"));
      assertFalse(called.get());
    } finally {
      exec.shutdownNow();
    }
  }

  @Test
  public void streamingDeliversHeadersDataEndAndAbortCancelsOpaqueHandle() throws Exception {
    FakeLynxContext lynx = new FakeLynxContext();
    AtomicBoolean cancelInvoked = new AtomicBoolean(false);
    java.util.concurrent.CountDownLatch abortReady = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.CountDownLatch cancelled = new java.util.concurrent.CountDownLatch(1);

    NativeSyncHttp.HttpTransport transport =
        new NativeSyncHttp.HttpTransport() {
          @Override
          public void stream(
              NativeSyncHttp.ParsedHttpRequest req,
              NativeSyncHttp.StreamCallbacks cb,
              Consumer<NativeSyncHttp.CancelHandle> onCancel) {
            onCancel.accept(
                () -> {
                  cancelInvoked.set(true);
                  cancelled.countDown();
                });
            cb.onHeaders(200, "OK", "application/x-ndjson");
            byte[] chunk = "{\"checkpoint\":1}\n".getBytes(StandardCharsets.UTF_8);
            cb.onBytes(chunk, 0, chunk.length);
            abortReady.countDown();
            try {
              cancelled.await(5, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
              Thread.currentThread().interrupt();
            }
            cb.onError(SyncHttpPolicy.ABORT_MESSAGE);
          }

          @Override
          public NativeSyncHttp.IdleOutcome fetchIdleComplete(
              NativeSyncHttp.ParsedHttpRequest req, boolean isSyncStream) {
            throw new AssertionError("expected streaming route");
          }
        };

    ExecutorService exec = directExecutor();
    try {
      NativeSyncHttp http =
          new NativeSyncHttp(() -> lynx, exec, transport, FAKE_SESSION_FACTORY, JVM_BASE64);
      WritableMap req = Arguments.createMap();
      req.putString("method", "POST");
      req.putString("url", "http://example.test/sync/stream");
      req.putString("body", "{}");

      ReadableMap env = fetchSync(http, req);
      assertTrue(env.getBoolean("ok"));
      String streamId = env.getString("streamingId");
      assertNotNull(streamId);
      assertTrue(streamId.startsWith(SyncHttpPolicy.STREAM_EVENT_PREFIX));
      assertFalse(env.getBoolean("idleComplete"));
      assertTrue(abortReady.await(5, java.util.concurrent.TimeUnit.SECONDS));

      AtomicBoolean abortOk = new AtomicBoolean(false);
      http.abort(
          streamId,
          args -> abortOk.set(((ReadableMap) args[0]).getBoolean("ok")));
      assertTrue(abortOk.get());
      assertTrue(cancelInvoked.get());

      exec.shutdown();
      assertTrue(exec.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals(3, lynx.events.size());
      assertEquals(SyncHttpPolicy.EVENT_ON_DATA, lynx.events.get(0).event);
      assertEquals("{\"checkpoint\":1}\n", lynx.events.get(0).data);
      assertEquals(SyncHttpPolicy.EVENT_ON_ERROR, lynx.events.get(1).event);
      assertEquals(SyncHttpPolicy.ABORT_MESSAGE, lynx.events.get(1).error);
      assertEquals(SyncHttpPolicy.EVENT_ON_END, lynx.events.get(2).event);
    } finally {
      exec.shutdownNow();
    }
  }

  @Test
  public void idleCompleteSetsFlagBase64AndMapsErrorsConsistently() throws Exception {
    AtomicReference<NativeSyncHttp.IdleOutcome> nextOutcome = new AtomicReference<>();
    NativeSyncHttp.HttpTransport transport =
        new NativeSyncHttp.HttpTransport() {
          @Override
          public void stream(
              NativeSyncHttp.ParsedHttpRequest req,
              NativeSyncHttp.StreamCallbacks cb,
              Consumer<NativeSyncHttp.CancelHandle> onCancel) {
            throw new AssertionError("expected idle route");
          }

          @Override
          public NativeSyncHttp.IdleOutcome fetchIdleComplete(
              NativeSyncHttp.ParsedHttpRequest req, boolean isSyncStream) throws IOException {
            return nextOutcome.get();
          }
        };

    ExecutorService exec = directExecutor();
    try {
      NativeSyncHttp http =
          new NativeSyncHttp(() -> null, exec, transport, FAKE_SESSION_FACTORY, JVM_BASE64);

      // /sync/stream idle cutoff -> idleComplete=true + Base64.
      nextOutcome.set(
          new NativeSyncHttp.IdleOutcome(
              200,
              "OK",
              "application/x-ndjson",
              "hello".getBytes(StandardCharsets.UTF_8),
              true,
              null));
      WritableMap syncReq = Arguments.createMap();
      syncReq.putString("url", "http://example.test/sync/stream");
      ReadableMap syncEnv = fetchSync(http, syncReq);
      assertTrue(syncEnv.getBoolean("ok"));
      assertTrue(syncEnv.getBoolean("idleComplete"));
      assertEquals("hello", syncEnv.getString("body"));
      assertEquals("aGVsbG8=", syncEnv.getString("bodyBase64"));

      // Non-sync JSON -> idleComplete=false.
      nextOutcome.set(
          new NativeSyncHttp.IdleOutcome(
              200,
              "OK",
              "application/json",
              "{\"ok\":1}".getBytes(StandardCharsets.UTF_8),
              false,
              null));
      WritableMap jsonReq = Arguments.createMap();
      jsonReq.putString("url", "http://example.test/token");
      ReadableMap jsonEnv = fetchSync(http, jsonReq);
      assertTrue(jsonEnv.getBoolean("ok"));
      assertFalse(jsonEnv.getBoolean("idleComplete"));
      assertEquals("{\"ok\":1}", jsonEnv.getString("body"));

      // Empty-body error -> ok=false, status=-1, idleComplete=false.
      nextOutcome.set(
          new NativeSyncHttp.IdleOutcome(
              (int) SyncHttpPolicy.FAIL_STATUS, "", null, new byte[0], false, "connect failed"));
      ReadableMap errEnv = fetchSync(http, syncReq);
      assertFalse(errEnv.getBoolean("ok"));
      assertEquals((double) SyncHttpPolicy.FAIL_STATUS, errEnv.getDouble("status"), 0.0);
      assertEquals("connect failed", errEnv.getString("message"));
      assertFalse(errEnv.getBoolean("idleComplete"));
    } finally {
      exec.shutdownNow();
    }
  }
}
