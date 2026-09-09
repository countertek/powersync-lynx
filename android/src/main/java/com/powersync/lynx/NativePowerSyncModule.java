package com.powersync.lynx;

import android.content.Context;
import androidx.annotation.Nullable;
import com.lynx.jsbridge.Arguments;
import com.lynx.jsbridge.LynxMethod;
import com.lynx.jsbridge.LynxModule;
import com.lynx.jsbridge.LynxNativeModule;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.ReadableArray;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.ReadableType;
import com.lynx.react.bridge.WritableMap;
import com.lynx.tasm.behavior.LynxContext;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lookup name: NativePowerSyncModule. Autolink via {@code @LynxNativeModule}.
 * Manual fallback: {@code LynxEnv.inst().registerModule("NativePowerSyncModule",
 * NativePowerSyncModule.class)}.
 *
 * <p>SQL RPC ({@code open}/{@code close}/{@code execute}/{@code executeBatch}) is a thin Lynx
 * binder over shared {@code ps_sql} (JNI). Bind parsing of Lynx {@code ReadableArray} stays here;
 * SQLite work is the same engine as iOS/desktop. Native Module HTTP lives in {@link
 * NativeSyncHttp} and is not merged into SQL.
 *
 * <p>Intentional remaining binder differences vs iOS/desktop: INTEGER beyond {@code
 * Number.MAX_SAFE_INTEGER} is Lynx {@code Long} (iOS tagged {@code {__psBig,v}}, N-API BigInt);
 * default file path is {@code Context.getDatabasePath} (iOS Documents); core load is {@code
 * sqlite3_load_extension(libpowersync.so)} from the Maven AAR.
 */
@LynxNativeModule(name = "NativePowerSyncModule")
public class NativePowerSyncModule extends LynxModule {
  private static final long MAX_SAFE = 9007199254740991L;

  private final ExecutorService executor = Executors.newCachedThreadPool();
  private final NativeSyncHttp syncHttp;

  public NativePowerSyncModule(Context context) {
    super(context);
    PsSqlEngine.ensureLoaded(appContext());
    syncHttp = new NativeSyncHttp(this::lynxContext, executor);
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
    if (options == null || !options.hasKey("dbFilename") || options.isNull("dbFilename")) {
      invoke(callback, fail("dbFilename is required"));
      return;
    }
    String dbFilename = options.getString("dbFilename");
    if (dbFilename == null || dbFilename.isEmpty()) {
      invoke(callback, fail("dbFilename is required"));
      return;
    }
    String dbLocation = null;
    if (options.hasKey("dbLocation") && !options.isNull("dbLocation")) {
      dbLocation = options.getString("dbLocation");
    } else if (!":memory:".equals(dbFilename) && !dbFilename.startsWith("file:")) {
      File dbFile = appContext().getDatabasePath(dbFilename);
      File dir = dbFile.getParentFile();
      if (dir != null && !dir.exists() && !dir.mkdirs()) {
        invoke(callback, fail("cannot create database directory"));
        return;
      }
      dbFilename = dbFile.getAbsolutePath();
    }
    boolean readOnly =
        options.hasKey("readOnly")
            && !options.isNull("readOnly")
            && options.getBoolean("readOnly");
    PsSqlEngine.nativeOpen(dbFilename, dbLocation, readOnly, callback);
  }

  @LynxMethod
  public void close(String dbId, Callback callback) {
    if (dbId == null) {
      invoke(callback, fail("close expects a dbId string"));
      return;
    }
    PsSqlEngine.nativeClose(dbId, callback);
  }

  @LynxMethod
  public void execute(String dbId, String sql, ReadableArray params, Callback callback) {
    if (dbId == null || sql == null) {
      invoke(callback, fail("execute expects dbId, sql, params"));
      return;
    }
    try {
      PsSqlEngine.nativeExecute(dbId, sql, readParams(params), callback);
    } catch (BindException e) {
      invoke(callback, fail(e.getMessage()));
    }
  }

  @LynxMethod
  public void executeBatch(String dbId, String sql, ReadableArray params, Callback callback) {
    if (dbId == null || sql == null) {
      invoke(callback, fail("executeBatch expects dbId, sql, params"));
      return;
    }
    try {
      PsSqlEngine.nativeExecuteBatch(dbId, sql, readParamRows(params), callback);
    } catch (BindException e) {
      invoke(callback, fail(e.getMessage()));
    }
  }

  /**
   * Native Module HTTP for PowerSync {@code /sync/stream}. Implementation lives in {@link
   * NativeSyncHttp} so SQL RPC stays {@code open}/{@code close}/{@code execute}/{@code
   * executeBatch}.
   */
  @LynxMethod
  public void httpFetch(ReadableMap request, Callback callback) {
    syncHttp.fetch(request, callback);
  }

  /** Cancel a live stream started by {@link #httpFetch}. */
  @LynxMethod
  public void httpFetchAbort(String streamId, Callback callback) {
    syncHttp.abort(streamId, callback);
  }

  private LynxContext lynxContext() {
    if (mContext instanceof LynxContext) {
      return (LynxContext) mContext;
    }
    return null;
  }

  private static Object[] readParams(@Nullable ReadableArray params) {
    if (params == null) {
      return new Object[0];
    }
    Object[] out = new Object[params.size()];
    for (int i = 0; i < params.size(); i++) {
      out[i] = readBind(params, i);
    }
    return out;
  }

  private static Object[][] readParamRows(@Nullable ReadableArray params) {
    if (params == null) {
      return new Object[0][];
    }
    Object[][] rows = new Object[params.size()][];
    for (int r = 0; r < params.size(); r++) {
      if (params.getType(r) != ReadableType.Array) {
        throw new BindException("params must be an array of parameter rows");
      }
      rows[r] = readParams(params.getArray(r));
    }
    return rows;
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

  private static WritableMap fail(String message) {
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", false);
    map.putString("message", message != null ? message : "native error");
    return map;
  }

  private static void invoke(Callback callback, WritableMap envelope) {
    if (callback != null) {
      callback.invoke(envelope);
    }
  }

  private static final class BindException extends RuntimeException {
    BindException(String message) {
      super(message);
    }
  }
}
