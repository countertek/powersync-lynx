package com.powersync.lynx;

import android.content.Context;
import androidx.annotation.Nullable;
import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import com.lynx.jsbridge.Arguments;
import com.lynx.jsbridge.LynxMethod;
import com.lynx.jsbridge.LynxModule;
import com.lynx.jsbridge.LynxNativeModule;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.JavaOnlyArray;
import com.lynx.react.bridge.JavaOnlyMap;
import com.lynx.react.bridge.ReadableArray;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.ReadableType;
import com.lynx.react.bridge.WritableArray;
import com.lynx.react.bridge.WritableMap;
import com.lynx.tasm.behavior.LynxContext;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lookup name: NativePowerSyncModule. Autolink via {@code @LynxNativeModule}.
 * Manual fallback: {@code LynxEnv.inst().registerModule("NativePowerSyncModule",
 * NativePowerSyncModule.class)}.
 */
@LynxNativeModule(name = "NativePowerSyncModule")
public class NativePowerSyncModule extends LynxModule {
  private static final long MAX_SAFE = 9007199254740991L;
  // androidx.sqlite throwSQLiteException: "Error code: N, message: ..."
  private static final Pattern SQLITE_ERROR_CODE = Pattern.compile("Error code: (-?\\d+)");
  private static final int SQLITE_INTEGER = 1;
  private static final int SQLITE_FLOAT = 2;
  private static final int SQLITE_TEXT = 3;
  private static final int SQLITE_BLOB = 4;
  private static final int SQLITE_NULL = 5;
  private static final int OPEN_READONLY = 0x00000001;
  private static final int OPEN_READWRITE = 0x00000002;
  private static final int OPEN_CREATE = 0x00000004;

  private static final String STREAM_EVENT_PREFIX = "NativePowerSyncHttpStream";

  private final ExecutorService executor = Executors.newCachedThreadPool();
  private final Map<String, Conn> dbs = new ConcurrentHashMap<>();
  private final Map<String, AtomicBoolean> activeStreams = new ConcurrentHashMap<>();
  private final AtomicLong nextId = new AtomicLong(1);
  private final AtomicLong nextStreamId = new AtomicLong(0);
  private final BundledSQLiteDriver driver;

  public NativePowerSyncModule(Context context) {
    super(context);
    driver = new BundledSQLiteDriver();
    driver.addExtension("libpowersync.so", "sqlite3_powersync_init");
  }

  public NativePowerSyncModule(LynxContext context) {
    this((Context) context);
  }

  Context appContext() {
    if (mContext instanceof LynxContext) {
      return ((LynxContext) mContext).getContext();
    }
    return (Context) mContext;
  }

  @LynxMethod
  public void open(ReadableMap options, Callback callback) {
    executor.execute(() -> invoke(callback, openSync(options)));
  }

  @LynxMethod
  public void close(String dbId, Callback callback) {
    executor.execute(() -> invoke(callback, closeSync(dbId)));
  }

  @LynxMethod
  public void execute(String dbId, String sql, ReadableArray params, Callback callback) {
    executor.execute(() -> invoke(callback, executeSync(dbId, sql, params)));
  }

  @LynxMethod
  public void executeBatch(String dbId, String sql, ReadableArray params, Callback callback) {
    executor.execute(() -> invoke(callback, executeBatchSync(dbId, sql, params)));
  }

  /**
   * HTTP for PowerSync {@code /sync/stream}.
   *
   * <p>When {@link LynxContext#sendGlobalEvent} is available (normal Lynx host), opens a live
   * stream: one Callback with {@code streamingId} + headers, then incremental UTF-8 {@code onData}
   * / {@code onEnd} / {@code onError} via GlobalEventEmitter (Lynx Callback is one-shot). Chunks are
   * <strong>strings</strong> — PrimJS drops large {@code byte[]} on this host.
   *
   * <p>Falls back to idle-complete one-shot UTF-8 body when GlobalEventEmitter cannot be reached
   * (plain Context unit tests).
   */
  @LynxMethod
  public void httpFetch(ReadableMap request, Callback callback) {
    ParsedHttpRequest parsed = parseHttpRequest(request);
    if (parsed.error != null) {
      invoke(callback, fail(parsed.error));
      return;
    }
    if (IdleCompleteHttp.isSyncStreamUrl(parsed.url) && lynxContext() != null) {
      executor.execute(() -> httpFetchStreaming(parsed, callback));
      return;
    }
    executor.execute(() -> invoke(callback, httpFetchIdleComplete(parsed)));
  }

  /** Cancel a live stream started by {@link #httpFetch}. */
  @LynxMethod
  public void httpFetchAbort(String streamId, Callback callback) {
    AtomicBoolean flag = streamId == null ? null : activeStreams.get(streamId);
    if (flag != null) {
      flag.set(true);
    }
    WritableMap ok = Arguments.createMap();
    ok.putBoolean("ok", true);
    invoke(callback, ok);
  }

  private void httpFetchStreaming(ParsedHttpRequest parsed, Callback callback) {
    final String streamId = STREAM_EVENT_PREFIX + nextStreamId.getAndIncrement();
    final AtomicBoolean cancelled = new AtomicBoolean(false);
    activeStreams.put(streamId, cancelled);
    final AtomicBoolean headersSent = new AtomicBoolean(false);
    try {
      StreamingHttp.stream(
          parsed.method,
          parsed.url,
          parsed.headers,
          parsed.bodyBytes,
          cancelled,
          new StreamingHttp.Listener() {
            @Override
            public void onHeaders(int status, String statusText, String contentType) {
              if (!headersSent.compareAndSet(false, true)) {
                return;
              }
              WritableMap ok = Arguments.createMap();
              ok.putBoolean("ok", true);
              ok.putDouble("status", status);
              ok.putString("statusText", statusText == null ? "" : statusText);
              if (contentType != null) {
                ok.putString("contentType", contentType);
              }
              ok.putString("body", "");
              ok.putString("streamingId", streamId);
              ok.putBoolean("idleComplete", false);
              invoke(callback, ok);
            }

            @Override
            public void onData(String utf8Chunk) {
              if (utf8Chunk == null || utf8Chunk.isEmpty()) {
                return;
              }
              sendStreamEvent(streamId, "onData", utf8Chunk, null);
            }

            @Override
            public void onEnd() {
              sendStreamEvent(streamId, "onEnd", null, null);
              activeStreams.remove(streamId);
            }

            @Override
            public void onError(String message) {
              if (!headersSent.get()) {
                invoke(callback, fail(message != null ? message : "httpFetch stream failed"));
              } else {
                sendStreamEvent(streamId, "onError", null, message);
              }
              activeStreams.remove(streamId);
            }
          });
    } catch (Throwable t) {
      activeStreams.remove(streamId);
      if (!headersSent.get()) {
        invoke(callback, fail(t.getMessage() != null ? t.getMessage() : "httpFetch failed"));
      } else {
        sendStreamEvent(
            streamId, "onError", null, t.getMessage() != null ? t.getMessage() : "httpFetch failed");
        sendStreamEvent(streamId, "onEnd", null, null);
      }
    }
  }

  private WritableMap httpFetchIdleComplete(ParsedHttpRequest parsed) {
    try {
      IdleCompleteHttp.Result result =
          IdleCompleteHttp.fetch(parsed.method, parsed.url, parsed.headers, parsed.bodyBytes);
      WritableMap ok = Arguments.createMap();
      ok.putBoolean("ok", true);
      ok.putDouble("status", result.status);
      ok.putString("statusText", result.statusText);
      String contentType = result.headers.get("content-type");
      if (contentType != null) {
        ok.putString("contentType", contentType);
      }
      String bodyText = IdleCompleteHttp.utf8(result.body);
      ok.putString("body", bodyText);
      ok.putString(
          "bodyBase64",
          android.util.Base64.encodeToString(result.body, android.util.Base64.NO_WRAP));
      ok.putBoolean("idleComplete", IdleCompleteHttp.isSyncStreamUrl(parsed.url));
      return ok;
    } catch (Throwable t) {
      return fail(t.getMessage() != null ? t.getMessage() : "httpFetch failed");
    }
  }

  private static final class ParsedHttpRequest {
    final String url;
    final String method;
    final Map<String, String> headers;
    final byte[] bodyBytes;
    final String error;

    ParsedHttpRequest(
        String url, String method, Map<String, String> headers, byte[] bodyBytes, String error) {
      this.url = url;
      this.method = method;
      this.headers = headers;
      this.bodyBytes = bodyBytes;
      this.error = error;
    }
  }

  private ParsedHttpRequest parseHttpRequest(ReadableMap request) {
    if (request == null || !request.hasKey("url") || request.isNull("url")) {
      return new ParsedHttpRequest(null, null, null, null, "url is required");
    }
    String url = request.getString("url");
    if (url == null || url.isEmpty()) {
      return new ParsedHttpRequest(null, null, null, null, "url is required");
    }
    String method =
        request.hasKey("method") && !request.isNull("method") ? request.getString("method") : "GET";
    Map<String, String> headers = new java.util.LinkedHashMap<>();
    if (request.hasKey("headers") && !request.isNull("headers")) {
      ReadableMap headerMap = request.getMap("headers");
      if (headerMap != null) {
        for (Map.Entry<String, Object> entry : headerMap.asHashMap().entrySet()) {
          if (entry.getKey() != null && entry.getValue() != null) {
            headers.put(entry.getKey(), String.valueOf(entry.getValue()));
          }
        }
      }
    }
    byte[] bodyBytes = null;
    if (request.hasKey("body") && !request.isNull("body")) {
      ReadableType bodyType = request.getType("body");
      if (bodyType == ReadableType.String) {
        bodyBytes = request.getString("body").getBytes(java.nio.charset.StandardCharsets.UTF_8);
      } else if (bodyType == ReadableType.ByteArray) {
        bodyBytes = request.getByteArray("body");
      }
    }
    return new ParsedHttpRequest(url, method, headers, bodyBytes, null);
  }

  private LynxContext lynxContext() {
    if (mContext instanceof LynxContext) {
      return (LynxContext) mContext;
    }
    return null;
  }

  private void sendStreamEvent(String streamId, String event, String data, String error) {
    LynxContext context = lynxContext();
    if (context == null) {
      return;
    }
    JavaOnlyMap payload = new JavaOnlyMap();
    payload.putString("event", event);
    if (data != null) {
      // UTF-8 string — not byte[] — so PrimJS delivers onData to LynxRemote.
      payload.putString("data", data);
    }
    if (error != null) {
      payload.putString("error", error);
    }
    JavaOnlyArray params = new JavaOnlyArray();
    params.pushMap(payload);
    context.sendGlobalEvent(streamId, params);
  }

  private WritableMap openSync(ReadableMap options) {
    try {
      if (options == null || !options.hasKey("dbFilename") || options.isNull("dbFilename")) {
        return fail("dbFilename is required");
      }
      String dbFilename = options.getString("dbFilename");
      if (dbFilename == null || dbFilename.isEmpty()) {
        return fail("dbFilename is required");
      }
      String path = dbFilename;
      if (options.hasKey("dbLocation") && !options.isNull("dbLocation")) {
        String location = options.getString("dbLocation");
        File dir = new File(location);
        if (!dir.isDirectory()) {
          return fail("dbLocation does not exist");
        }
        if (!":memory:".equals(dbFilename) && !dbFilename.startsWith("file:")) {
          path = new File(dir, dbFilename).getAbsolutePath();
        }
      } else if (!":memory:".equals(dbFilename) && !dbFilename.startsWith("file:")) {
        path = appContext().getDatabasePath(dbFilename).getAbsolutePath();
      }
      boolean readOnly =
          options.hasKey("readOnly")
              && !options.isNull("readOnly")
              && options.getBoolean("readOnly");
      int flags = readOnly ? OPEN_READONLY : (OPEN_READWRITE | OPEN_CREATE);
      SQLiteConnection connection = driver.open(path, flags);
      String dbId = "ps-" + nextId.getAndIncrement();
      dbs.put(dbId, new Conn(connection));
      WritableMap ok = Arguments.createMap();
      ok.putBoolean("ok", true);
      ok.putString("dbId", dbId);
      return ok;
    } catch (Throwable t) {
      return failFrom(t);
    }
  }

  private WritableMap closeSync(String dbId) {
    Conn conn = dbs.remove(dbId);
    if (conn == null) {
      return fail("unknown dbId");
    }
    synchronized (conn.lock) {
      try {
        conn.connection.close();
        WritableMap ok = Arguments.createMap();
        ok.putBoolean("ok", true);
        return ok;
      } catch (Throwable t) {
        dbs.put(dbId, conn);
        return failFrom(t);
      }
    }
  }

  private WritableMap executeSync(String dbId, String sql, ReadableArray params) {
    Conn conn = dbs.get(dbId);
    if (conn == null) {
      return fail("unknown dbId");
    }
    synchronized (conn.lock) {
      try {
        List<Object> binds = readParams(params);
        return run(conn.connection, sql, binds);
      } catch (BindException e) {
        return fail(e.getMessage());
      } catch (Throwable t) {
        return failFrom(t);
      }
    }
  }

  private WritableMap executeBatchSync(String dbId, String sql, ReadableArray params) {
    Conn conn = dbs.get(dbId);
    if (conn == null) {
      return fail("unknown dbId");
    }
    synchronized (conn.lock) {
      SQLiteStatement stmt = null;
      boolean startedTx = false;
      try {
        startedTx = beginImmediate(conn.connection);
        stmt = conn.connection.prepare(sql);
        WritableArray columnNames = columnNames(stmt);
        WritableArray lastRows = Arguments.createArray();
        long rowsAffected = 0;
        long insertId = 0;
        int rowCount = params == null ? 0 : params.size();
        for (int r = 0; r < rowCount; r++) {
          if (params.getType(r) != ReadableType.Array) {
            if (startedTx) {
              execSql(conn.connection, "ROLLBACK");
            }
            return fail("params must be an array of parameter rows");
          }
          stmt.reset();
          stmt.clearBindings();
          ReadableArray row = params.getArray(r);
          bindAll(stmt, readParams(row));
          lastRows = stepRows(stmt);
          insertId = lastInsertRowid(conn.connection);
          rowsAffected += changes(conn.connection);
        }
        if (startedTx) {
          execSql(conn.connection, "COMMIT");
        }
        return successExecute(insertId, rowsAffected, columnNames, lastRows);
      } catch (BindException e) {
        if (startedTx) {
          execSqlQuiet(conn.connection, "ROLLBACK");
        }
        return fail(e.getMessage());
      } catch (Throwable t) {
        if (startedTx) {
          execSqlQuiet(conn.connection, "ROLLBACK");
        }
        return failFrom(t);
      } finally {
        if (stmt != null) {
          stmt.close();
        }
      }
    }
  }

  private WritableMap run(SQLiteConnection connection, String sql, List<Object> binds)
      throws Exception {
    SQLiteStatement stmt = connection.prepare(sql);
    try {
      bindAll(stmt, binds);
      WritableArray columnNames = columnNames(stmt);
      WritableArray rows = stepRows(stmt);
      return successExecute(lastInsertRowid(connection), changes(connection), columnNames, rows);
    } finally {
      stmt.close();
    }
  }

  private static WritableArray columnNames(SQLiteStatement stmt) {
    WritableArray names = Arguments.createArray();
    int count = stmt.getColumnCount();
    for (int i = 0; i < count; i++) {
      names.pushString(stmt.getColumnName(i));
    }
    return names;
  }

  private static WritableArray stepRows(SQLiteStatement stmt) {
    WritableArray rows = Arguments.createArray();
    while (stmt.step()) {
      WritableArray row = Arguments.createArray();
      int count = stmt.getColumnCount();
      for (int i = 0; i < count; i++) {
        pushCell(row, stmt, i);
      }
      rows.pushArray(row);
    }
    return rows;
  }

  private static void pushCell(WritableArray row, SQLiteStatement stmt, int i) {
    int type = stmt.getColumnType(i);
    if (type == SQLITE_NULL) {
      row.pushNull();
    } else if (type == SQLITE_INTEGER) {
      long value = stmt.getLong(i);
      if (value > MAX_SAFE || value < -MAX_SAFE) {
        row.pushLong(value);
      } else {
        row.pushDouble((double) value);
      }
    } else if (type == SQLITE_FLOAT) {
      row.pushDouble(stmt.getDouble(i));
    } else if (type == SQLITE_TEXT) {
      row.pushString(stmt.getText(i));
    } else if (type == SQLITE_BLOB) {
      byte[] blob = stmt.getBlob(i);
      row.pushByteArray(blob);
    } else {
      row.pushNull();
    }
  }

  private static void bindAll(SQLiteStatement stmt, List<Object> binds) {
    for (int i = 0; i < binds.size(); i++) {
      Object value = binds.get(i);
      int index = i + 1;
      if (value == null) {
        stmt.bindNull(index);
      } else if (value instanceof Long) {
        stmt.bindLong(index, (Long) value);
      } else if (value instanceof Double) {
        stmt.bindDouble(index, (Double) value);
      } else if (value instanceof String) {
        stmt.bindText(index, (String) value);
      } else if (value instanceof byte[]) {
        stmt.bindBlob(index, (byte[]) value);
      } else {
        throw new BindException("unsupported bind value");
      }
    }
  }

  private static List<Object> readParams(@Nullable ReadableArray params) {
    List<Object> out = new ArrayList<>();
    if (params == null) {
      return out;
    }
    for (int i = 0; i < params.size(); i++) {
      out.add(readBind(params, i));
    }
    return out;
  }

  private static Object readBind(ReadableArray params, int i) {
    ReadableType type = params.getType(i);
    if (type == ReadableType.Null) {
      return null;
    }
    if (type == ReadableType.Number || type == ReadableType.Int) {
      double number = params.getDouble(i);
      if (number == Math.rint(number) && number <= MAX_SAFE && number >= -MAX_SAFE) {
        return Long.valueOf((long) number);
      }
      return Double.valueOf(number);
    }
    if (type == ReadableType.Long) {
      return Long.valueOf(params.getLong(i));
    }
    if (type == ReadableType.String) {
      return params.getString(i);
    }
    if (type == ReadableType.ByteArray || type == ReadableType.ByteBuffer) {
      return params.getByteArray(i);
    }
    if (type == ReadableType.Map) {
      return readTaggedBind(params.getMap(i));
    }
    if (type == ReadableType.Boolean || type == ReadableType.Array) {
      throw new BindException("unsupported bind value");
    }
    try {
      return params.getByteArray(i);
    } catch (Throwable ignored) {
      throw new BindException("unsupported bind value");
    }
  }

  private static long lastInsertRowid(SQLiteConnection connection) {
    SQLiteStatement stmt = connection.prepare("SELECT last_insert_rowid()");
    try {
      stmt.step();
      return stmt.getLong(0);
    } finally {
      stmt.close();
    }
  }

  private static long changes(SQLiteConnection connection) {
    SQLiteStatement stmt = connection.prepare("SELECT changes()");
    try {
      stmt.step();
      return stmt.getLong(0);
    } finally {
      stmt.close();
    }
  }

  private static WritableMap successExecute(
      long insertId, long rowsAffected, WritableArray columnNames, WritableArray rawRows) {
    WritableMap ok = Arguments.createMap();
    ok.putBoolean("ok", true);
    ok.putDouble("insertId", (double) insertId);
    ok.putDouble("rowsAffected", (double) rowsAffected);
    ok.putArray("columnNames", columnNames);
    ok.putArray("rawRows", rawRows);
    return ok;
  }

  private static WritableMap fail(String message) {
    return fail(message, null);
  }

  private static WritableMap failFrom(Throwable t) {
    String message = messageOf(t);
    return fail(message, sqliteCode(message));
  }

  private static WritableMap fail(String message, Integer code) {
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", false);
    map.putString("message", message != null ? message : "native error");
    if (code != null) {
      map.putDouble("code", code.doubleValue());
    }
    return map;
  }

  private static Integer sqliteCode(String message) {
    if (message == null) {
      return null;
    }
    Matcher matcher = SQLITE_ERROR_CODE.matcher(message);
    if (!matcher.find()) {
      return null;
    }
    return Integer.valueOf(matcher.group(1));
  }

  private static String messageOf(Throwable t) {
    return t.getMessage() != null ? t.getMessage() : t.getClass().getName();
  }


  private static Object readTaggedBind(ReadableMap map) {
    if (map != null
        && map.hasKey("__psBig")
        && !map.isNull("__psBig")
        && map.getBoolean("__psBig")
        && map.hasKey("v")
        && !map.isNull("v")) {
      String encoded = map.getString("v");
      try {
        return Long.valueOf(encoded);
      } catch (NumberFormatException e) {
        throw new BindException("invalid tagged bigint");
      }
    }
    throw new BindException("unsupported bind value");
  }

  private static boolean beginImmediate(SQLiteConnection connection) throws Exception {
    try {
      execSql(connection, "BEGIN IMMEDIATE");
      return true;
    } catch (Throwable t) {
      String message = messageOf(t);
      if (message != null && message.toLowerCase(Locale.US).contains("within a transaction")) {
        return false;
      }
      if (t instanceof Exception) {
        throw (Exception) t;
      }
      throw new Exception(message, t);
    }
  }

  private static void execSql(SQLiteConnection connection, String sql) throws Exception {
    SQLiteStatement stmt = connection.prepare(sql);
    try {
      stmt.step();
    } finally {
      stmt.close();
    }
  }

  private static void execSqlQuiet(SQLiteConnection connection, String sql) {
    try {
      execSql(connection, sql);
    } catch (Throwable ignored) {
      // ROLLBACK after a failed batch; ignore if no transaction remains.
    }
  }

  private static void invoke(Callback callback, WritableMap envelope) {
    if (callback != null) {
      callback.invoke(envelope);
    }
  }

  private static final class Conn {
    final SQLiteConnection connection;
    final Object lock = new Object();

    Conn(SQLiteConnection connection) {
      this.connection = connection;
    }
  }

  private static final class BindException extends RuntimeException {
    BindException(String message) {
      super(message);
    }
  }
}
