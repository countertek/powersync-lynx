package com.powersync.lynx;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.lynx.react.bridge.Arguments;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.JavaOnlyArray;
import com.lynx.react.bridge.JavaOnlyMap;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.WritableMap;
import com.lynx.tasm.behavior.LynxContext;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeSyncHttpFixtureTest {
  @Test
  public void sharedNdjsonFixturesDriveHttpFetch() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    JSONObject catalog = loadCatalog(context);
    JSONObject checkpoint = scenario(catalog, "checkpoint-ops");
    JSONObject idle = scenario(catalog, "idle-complete");
    JSONObject split = scenario(catalog, "split-multibyte");
    String contentType = catalog.getString("contentType");
    String checkpointBody = joinedChunks(checkpoint);
    String idleBody = joinedChunks(idle);

    new NativePowerSyncModule(context);
    byte[] firstWire = hexBytes(split.getJSONArray("wireChunksHex").getString(0));
    expect(
        StreamingHttp.trailingIncompleteUtf8Bytes(firstWire) == 1,
        "JNI hold counts the 3-byte euro lead from split-multibyte");
    expect(
        StreamingHttp.trailingIncompleteUtf8Bytes(joinedWire(split)) == 0,
        "JNI hold is 0 for complete split-multibyte wire");

    try (ReplayServer streamServer = ReplayServer.start(contentType, checkpointBody)) {
      RecordingLynxContext lynx = new RecordingLynxContext(context);
      NativePowerSyncModule module = new NativePowerSyncModule(lynx);
      WritableMap request = Arguments.createMap();
      request.putString("method", "POST");
      request.putString("url", streamServer.url());
      request.putString("body", "{}");
      ReadableMap headers = await(callback -> module.httpFetch(request, callback));
      expect(headers.getBoolean("ok"), "streaming httpFetch ok");
      String streamingId = headers.getString("streamingId");
      expect(
          streamingId != null && streamingId.startsWith(SyncHttpPolicy.STREAM_EVENT_PREFIX),
          "streaming httpFetch returns streamingId");
      expect(!headers.getBoolean("idleComplete"), "streaming idleComplete is false");
      expect(
          headers.getString("body") == null || headers.getString("body").isEmpty(),
          "streaming body is empty");
      expect(lynx.waitForEnd(10, TimeUnit.SECONDS), "onEnd after onData");
      List<RecordingLynxContext.Event> events = lynx.snapshot();
      expect(
          !events.isEmpty() && SyncHttpPolicy.EVENT_ON_DATA.equals(events.get(0).event),
          "first event is onData");
      expect(
          SyncHttpPolicy.EVENT_ON_END.equals(events.get(events.size() - 1).event),
          "terminal event is onEnd");
      expect(!lynx.sawError(), "checkpoint-ops has no onError");
      expect(lynx.joinedData().equals(checkpointBody), "onData concatenates checkpoint-ops NDJSON");
    }

    try (ReplayServer idleServer = ReplayServer.start(contentType, idleBody)) {
      NativePowerSyncModule module = new NativePowerSyncModule(context);
      WritableMap request = Arguments.createMap();
      request.putString("method", "POST");
      request.putString("url", idleServer.url());
      request.putString("body", "{}");
      ReadableMap envelope = await(callback -> module.httpFetch(request, callback));
      expect(envelope.getBoolean("ok"), "idle-complete httpFetch ok");
      expect(
          !envelope.hasKey("streamingId")
              || envelope.isNull("streamingId")
              || envelope.getString("streamingId").isEmpty(),
          "idle-complete envelope has no streamingId");
      expect(envelope.getBoolean("idleComplete"), "idle-complete envelope idleComplete is true");
      expect(idleBody.equals(envelope.getString("body")), "idle-complete UTF-8 body matches fixture");
      expect(
          envelope.hasKey("bodyBase64")
              && envelope.getString("bodyBase64") != null
              && !envelope.getString("bodyBase64").isEmpty(),
          "idle-complete envelope has bodyBase64");
    }
  }

  @Test
  public void preHeadersFailureEnvelopeMatchesSessionContract() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    new NativePowerSyncModule(context);
    RecordingLynxContext lynx = new RecordingLynxContext(context);
    NativePowerSyncModule module = new NativePowerSyncModule(lynx);

    WritableMap missingUrl = Arguments.createMap();
    missingUrl.putString("method", "POST");
    ReadableMap parseFail = await(callback -> module.httpFetch(missingUrl, callback));
    assertFailEnvelope(parseFail, "parse missing url");
    expect(lynx.snapshot().isEmpty(), "parse fail emits no GlobalEventEmitter events");

    try (ReplayServer rst = ReplayServer.start(ReplayServer.Mode.RST_BEFORE_HEADERS, "text/plain", "")) {
      WritableMap request = Arguments.createMap();
      request.putString("method", "GET");
      request.putString("url", rst.url());
      ReadableMap envelope = await(callback -> module.httpFetch(request, callback));
      assertFailEnvelope(envelope, "RST before headers");
      expect(!lynx.sawError() && lynx.snapshot().isEmpty(), "pre-headers RST has no stream events");
    }
  }

  @Test
  public void abortAfterHeadersEmitsErrorThenEnd() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    JSONObject catalog = loadCatalog(context);
    JSONObject checkpoint = scenario(catalog, "checkpoint-ops");
    String contentType = catalog.getString("contentType");
    String first = checkpoint.getJSONArray("chunks").getString(0);
    new NativePowerSyncModule(context);

    try (ReplayServer hold =
        ReplayServer.start(ReplayServer.Mode.HOLD_OPEN, contentType, first)) {
      RecordingLynxContext lynx = new RecordingLynxContext(context);
      NativePowerSyncModule module = new NativePowerSyncModule(lynx);
      WritableMap request = Arguments.createMap();
      request.putString("method", "GET");
      request.putString("url", hold.url());
      ReadableMap headers = await(callback -> module.httpFetch(request, callback));
      expect(headers.getBoolean("ok"), "abort path received headers");
      String streamingId = headers.getString("streamingId");
      expect(streamingId != null, "abort path received streamingId");
      expect(lynx.waitForEventCount(1, 10, TimeUnit.SECONDS), "abort path got initial onData");
      int before = lynx.snapshot().size();
      ReadableMap aborted =
          await(callback -> module.httpFetchAbort(streamingId, callback));
      expect(aborted.getBoolean("ok"), "httpFetchAbort returns ok");
      expect(lynx.waitForEventCount(before + 2, 10, TimeUnit.SECONDS),
          "abort emits onError then onEnd");
      expect(lynx.sawError(), "abort after headers emits onError");
      List<RecordingLynxContext.Event> events = lynx.snapshot();
      expect(
          SyncHttpPolicy.EVENT_ON_END.equals(events.get(events.size() - 1).event),
          "abort terminal sequence ends with onEnd");
    }
  }

  @Test
  public void errorThenEndAfterFirstChunk() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    JSONObject catalog = loadCatalog(context);
    JSONObject errored = scenario(catalog, "error-then-end");
    String contentType = catalog.getString("contentType");
    String first = errored.getJSONArray("chunks").getString(0);
    new NativePowerSyncModule(context);

    try (ReplayServer rst =
        ReplayServer.start(ReplayServer.Mode.RST_AFTER_FIRST, contentType, first)) {
      RecordingLynxContext lynx = new RecordingLynxContext(context);
      NativePowerSyncModule module = new NativePowerSyncModule(lynx);
      WritableMap request = Arguments.createMap();
      request.putString("method", "POST");
      request.putString("url", rst.url());
      request.putString("body", "{}");
      ReadableMap headers = await(callback -> module.httpFetch(request, callback));
      expect(headers.getBoolean("ok"), "error-then-end headers ok");
      expect(lynx.waitForEnd(10, TimeUnit.SECONDS), "error-then-end waits for onEnd");
      expect(lynx.sawError(), "error-then-end records onError");
      List<RecordingLynxContext.Event> events = lynx.snapshot();
      expect(
          SyncHttpPolicy.EVENT_ON_END.equals(events.get(events.size() - 1).event),
          "error-then-end terminal is onEnd");
      expect(lynx.joinedData().equals(first), "error-then-end onData is the first fixture chunk");
    }
  }

  private static void assertFailEnvelope(ReadableMap envelope, String what) {
    expect(envelope.getBoolean("ok") == false, what + ": ok is false");
    expect(envelope.getDouble("status") == SyncHttpSession.FAIL_STATUS, what + ": status is -1");
    expect(envelope.hasKey("message") && envelope.getString("message") != null,
        what + ": message present");
    expect(envelope.hasKey("body"), what + ": body present");
    expect(envelope.hasKey("idleComplete") && !envelope.getBoolean("idleComplete"),
        what + ": idleComplete is false");
  }

  private static JSONObject loadCatalog(Context context) throws Exception {
    try (InputStream in = context.getAssets().open("sync-stream.json")) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      int n;
      while ((n = in.read(buf)) >= 0) {
        out.write(buf, 0, n);
      }
      return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
    }
  }

  private static JSONObject scenario(JSONObject catalog, String id) throws Exception {
    JSONArray scenarios = catalog.getJSONArray("scenarios");
    for (int i = 0; i < scenarios.length(); i++) {
      JSONObject row = scenarios.getJSONObject(i);
      if (id.equals(row.getString("id"))) {
        return row;
      }
    }
    fail("missing scenario " + id);
    return new JSONObject();
  }

  private static String joinedChunks(JSONObject scenario) throws Exception {
    JSONArray chunks = scenario.getJSONArray("chunks");
    StringBuilder body = new StringBuilder();
    for (int i = 0; i < chunks.length(); i++) {
      body.append(chunks.getString(i));
    }
    return body.toString();
  }

  private static byte[] hexBytes(String hex) {
    int n = hex.length() / 2;
    byte[] out = new byte[n];
    for (int i = 0; i < n; i++) {
      out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  private static byte[] joinedWire(JSONObject scenario) throws Exception {
    JSONArray hex = scenario.getJSONArray("wireChunksHex");
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i < hex.length(); i++) {
      out.write(hexBytes(hex.getString(i)));
    }
    return out.toByteArray();
  }

  private static ReadableMap await(RpcCall call) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<ReadableMap> result = new AtomicReference<>();
    call.launch(
        args -> {
          if (args != null && args.length > 0 && args[0] instanceof ReadableMap) {
            result.set((ReadableMap) args[0]);
          }
          done.countDown();
        });
    assertTrue("callback timed out", done.await(30, TimeUnit.SECONDS));
    assertNotNull("callback envelope missing", result.get());
    return result.get();
  }

  private static void expect(boolean cond, String what) {
    if (cond) {
      System.out.println("ok: " + what);
    } else {
      fail(what);
    }
  }

  private interface RpcCall {
    void launch(Callback callback);
  }

  static final class RecordingLynxContext extends LynxContext {
    static final class Event {
      final String name;
      final String event;
      final String data;
      final String error;

      Event(String name, String event, String data, String error) {
        this.name = name;
        this.event = event;
        this.data = data;
        this.error = error;
      }
    }

    private final List<Event> events = new CopyOnWriteArrayList<>();
    private final CountDownLatch ended = new CountDownLatch(1);
    private final Object eventLock = new Object();

    RecordingLynxContext(Context base) {
      super(base);
    }

    @Override
    public void sendGlobalEvent(String name, JavaOnlyArray params) {
      String event = "";
      String data = null;
      String error = null;
      if (params != null) {
        for (Object item : params.asList()) {
          if (item instanceof JavaOnlyMap) {
            Map<String, Object> map = ((JavaOnlyMap) item).asHashMap();
            Object eventValue = map.get("event");
            if (eventValue != null) {
              event = String.valueOf(eventValue);
            }
            Object dataValue = map.get("data");
            if (dataValue != null) {
              data = String.valueOf(dataValue);
            }
            Object errorValue = map.get("error");
            if (errorValue != null) {
              error = String.valueOf(errorValue);
            }
            break;
          }
        }
      }
      events.add(new Event(name, event, data, error));
      synchronized (eventLock) {
        eventLock.notifyAll();
      }
      if (SyncHttpPolicy.EVENT_ON_END.equals(event)) {
        ended.countDown();
      }
    }

    List<Event> snapshot() {
      return new ArrayList<>(events);
    }

    boolean waitForEnd(long timeout, TimeUnit unit) throws InterruptedException {
      return ended.await(timeout, unit);
    }

    boolean waitForEventCount(int count, long timeout, TimeUnit unit) throws InterruptedException {
      long deadline = System.nanoTime() + unit.toNanos(timeout);
      synchronized (eventLock) {
        while (events.size() < count) {
          long remaining = deadline - System.nanoTime();
          if (remaining <= 0) {
            return false;
          }
          eventLock.wait(remaining / 1_000_000L, (int) (remaining % 1_000_000L));
        }
      }
      return events.size() >= count;
    }

    boolean sawError() {
      for (Event event : events) {
        if (SyncHttpPolicy.EVENT_ON_ERROR.equals(event.event)) {
          return true;
        }
      }
      return false;
    }

    String joinedData() {
      StringBuilder body = new StringBuilder();
      for (Event event : events) {
        if (SyncHttpPolicy.EVENT_ON_DATA.equals(event.event) && event.data != null) {
          body.append(event.data);
        }
      }
      return body.toString();
    }
  }

  static final class ReplayServer implements AutoCloseable {
    enum Mode {
      CLEAN,
      HOLD_OPEN,
      RST_BEFORE_HEADERS,
      RST_AFTER_FIRST
    }

    private final ServerSocket server;
    private final Thread worker;
    private volatile boolean stop;

    private ReplayServer(ServerSocket server, Mode mode, String contentType, String body) {
      this.server = server;
      this.worker =
          new Thread(
              () -> {
                while (!stop) {
                  try (Socket socket = server.accept()) {
                    readHeaders(socket.getInputStream());
                    if (mode == Mode.RST_BEFORE_HEADERS) {
                      rstClose(socket);
                      continue;
                    }
                    OutputStream out = socket.getOutputStream();
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    if (mode == Mode.RST_AFTER_FIRST || mode == Mode.HOLD_OPEN) {
                      String header =
                          "HTTP/1.1 200 OK\r\nContent-Type: "
                              + contentType
                              + "\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                      out.write(header.getBytes(StandardCharsets.US_ASCII));
                      writeChunked(out, bytes);
                      out.flush();
                      if (mode == Mode.RST_AFTER_FIRST) {
                        rstClose(socket);
                        continue;
                      }
                      for (int i = 0; i < 50 && !stop; i++) {
                        Thread.sleep(100);
                      }
                      out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                      out.flush();
                      continue;
                    }
                    String header =
                        "HTTP/1.1 200 OK\r\nContent-Type: "
                            + contentType
                            + "\r\nContent-Length: "
                            + bytes.length
                            + "\r\nConnection: close\r\n\r\n";
                    out.write(header.getBytes(StandardCharsets.US_ASCII));
                    out.write(bytes);
                    out.flush();
                  } catch (Exception ignored) {
                    if (stop) {
                      return;
                    }
                  }
                }
              },
              "ndjson-replay");
      this.worker.setDaemon(true);
      this.worker.start();
    }

    static ReplayServer start(String contentType, String body) throws Exception {
      return start(Mode.CLEAN, contentType, body);
    }

    static ReplayServer start(Mode mode, String contentType, String body) throws Exception {
      ServerSocket server = new ServerSocket(0);
      server.setReuseAddress(true);
      return new ReplayServer(server, mode, contentType, body);
    }

    private static void writeChunked(OutputStream out, byte[] bytes) throws Exception {
      if (bytes.length == 0) {
        return;
      }
      out.write((Integer.toHexString(bytes.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
      out.write(bytes);
      out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private static void rstClose(Socket socket) {
      try {
        socket.setSoLinger(true, 0);
        socket.close();
      } catch (Exception ignored) {
      }
    }

    String url() {
      return "http://127.0.0.1:" + server.getLocalPort() + "/sync/stream";
    }

    @Override
    public void close() {
      stop = true;
      try {
        server.close();
      } catch (Exception ignored) {
      }
      worker.interrupt();
    }

    private static void readHeaders(InputStream in) throws Exception {
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      byte[] scratch = new byte[256];
      while (buf.size() < 65536) {
        int n = in.read(scratch);
        if (n < 0) {
          return;
        }
        buf.write(scratch, 0, n);
        if (buf.toString("US-ASCII").contains("\r\n\r\n")) {
          return;
        }
      }
    }
  }
}
