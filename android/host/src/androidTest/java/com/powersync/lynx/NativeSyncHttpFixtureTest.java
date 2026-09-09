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
    String contentType = catalog.getString("contentType");
    String checkpointBody = joinedChunks(checkpoint);
    String idleBody = joinedChunks(idle);

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
    private final ServerSocket server;
    private final Thread worker;
    private volatile boolean stop;

    private ReplayServer(ServerSocket server, String contentType, String body) {
      this.server = server;
      this.worker =
          new Thread(
              () -> {
                while (!stop) {
                  try (Socket socket = server.accept()) {
                    readHeaders(socket.getInputStream());
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    String header =
                        "HTTP/1.1 200 OK\r\nContent-Type: "
                            + contentType
                            + "\r\nContent-Length: "
                            + bytes.length
                            + "\r\nConnection: close\r\n\r\n";
                    OutputStream out = socket.getOutputStream();
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
      ServerSocket server = new ServerSocket(0);
      server.setReuseAddress(true);
      return new ReplayServer(server, contentType, body);
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
