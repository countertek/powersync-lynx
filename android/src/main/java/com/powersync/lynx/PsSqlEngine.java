package com.powersync.lynx;

import android.content.Context;
import androidx.annotation.Keep;
import androidx.annotation.Nullable;
import com.lynx.jsbridge.Arguments;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.WritableArray;
import com.lynx.react.bridge.WritableMap;
import java.io.File;

/**
 * JNI binder onto shared {@code ps_sql}. Lynx Autolink methods stay on {@link
 * NativePowerSyncModule}; this class is the SQL engine seam (HTTP stays in {@link NativeSyncHttp}).
 */
@Keep
final class PsSqlEngine {
  private static boolean loaded;

  private PsSqlEngine() {}

  static synchronized void ensureLoaded(Context context) {
    if (loaded) {
      return;
    }
    System.loadLibrary("powersync");
    System.loadLibrary("powersync_lynx_sql");
    File so = new File(context.getApplicationInfo().nativeLibraryDir, "libpowersync.so");
    String path = so.isFile() ? so.getAbsolutePath() : "libpowersync.so";
    nativeInit(path);
    loaded = true;
  }

  static native void nativeInit(String corePath);

  static native void nativeOpen(
      String dbFilename, @Nullable String dbLocation, boolean readOnly, Callback callback);

  static native void nativeClose(String dbId, Callback callback);

  static native void nativeExecute(String dbId, String sql, Object[] params, Callback callback);

  static native void nativeExecuteBatch(
      String dbId, String sql, Object[][] rows, Callback callback);

  @Keep
  static WritableMap toWritable(
      boolean ok,
      @Nullable String message,
      boolean hasCode,
      int code,
      @Nullable String dbId,
      long insertId,
      long rowsAffected,
      @Nullable String[] columnNames,
      @Nullable Object[][] rawRows) {
    WritableMap map = Arguments.createMap();
    map.putBoolean("ok", ok);
    if (!ok) {
      map.putString("message", message != null ? message : "native error");
      if (hasCode) {
        map.putDouble("code", code);
      }
      return map;
    }
    if (dbId != null && !dbId.isEmpty()) {
      map.putString("dbId", dbId);
    }
    map.putDouble("insertId", (double) insertId);
    map.putDouble("rowsAffected", (double) rowsAffected);
    WritableArray names = Arguments.createArray();
    if (columnNames != null) {
      for (String name : columnNames) {
        names.pushString(name != null ? name : "");
      }
    }
    map.putArray("columnNames", names);
    WritableArray rows = Arguments.createArray();
    if (rawRows != null) {
      for (Object[] row : rawRows) {
        rows.pushArray(cellsToArray(row));
      }
    }
    map.putArray("rawRows", rows);
    return map;
  }

  private static WritableArray cellsToArray(@Nullable Object[] row) {
    WritableArray out = Arguments.createArray();
    if (row == null) {
      return out;
    }
    for (Object cell : row) {
      if (cell == null) {
        out.pushNull();
      } else if (cell instanceof Long) {
        out.pushLong((Long) cell);
      } else if (cell instanceof Double) {
        out.pushDouble((Double) cell);
      } else if (cell instanceof String) {
        out.pushString((String) cell);
      } else if (cell instanceof byte[]) {
        out.pushByteArray((byte[]) cell);
      } else {
        out.pushNull();
      }
    }
    return out;
  }
}
