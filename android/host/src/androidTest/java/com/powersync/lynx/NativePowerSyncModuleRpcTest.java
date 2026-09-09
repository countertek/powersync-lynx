package com.powersync.lynx;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.lynx.react.bridge.Arguments;
import com.lynx.react.bridge.Callback;
import com.lynx.react.bridge.ReadableArray;
import com.lynx.react.bridge.ReadableMap;
import com.lynx.react.bridge.WritableArray;
import com.lynx.react.bridge.WritableMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativePowerSyncModuleRpcTest {
  @Test
  public void nativePowerSyncModuleRpc() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    NativePowerSyncModule module = new NativePowerSyncModule(context);

    WritableMap openOptions = Arguments.createMap();
    openOptions.putString("dbFilename", ":memory:");
    ReadableMap opened = await(callback -> module.open(openOptions, callback));
    printEnvelope("open", opened);
    expect(opened.getBoolean("ok"), "open success ok=true");
    String dbId = opened.getString("dbId");
    expect(dbId != null && dbId.startsWith("ps-"), "open returns opaque dbId");

    ReadableMap version =
        await(callback -> module.execute(dbId, "SELECT powersync_rs_version()", empty(), callback));
    printEnvelope("powersync_rs_version", version);
    expect(version.getBoolean("ok"), "core-load: powersync_rs_version ok");
    String versionText = firstString(version);
    expect(versionText != null && versionText.startsWith("0.5.3"), "core-load: version text cell");
    System.out.println("powersync_rs_version=" + versionText);

    ReadableMap sqliteVersion =
        await(callback -> module.execute(dbId, "SELECT sqlite_version()", empty(), callback));
    printEnvelope("sqlite_version", sqliteVersion);
    expect(sqliteVersion.getBoolean("ok"), "sqlite_version ok");
    String sqliteText = firstString(sqliteVersion);
    expect(sqliteText != null && compareVersion(sqliteText, "3.44") >= 0, "bundled SQLite 3.44+");
    System.out.println("sqlite_version=" + sqliteText);

    ReadableMap stringTypeof =
        await(
            callback ->
                module.execute(dbId, "SELECT typeof(?)", stringParams("9007199254740993"), callback));
    expect(stringTypeof.getBoolean("ok"), "String snowflake bind ok");
    expect("text".equals(firstString(stringTypeof)), "String snowflake BindValue stays TEXT");

    WritableMap tagged = Arguments.createMap();
    tagged.putBoolean("__psBig", true);
    tagged.putString("v", "99");
    WritableArray taggedParams = Arguments.createArray();
    taggedParams.pushMap(tagged);
    ReadableMap taggedType =
        await(callback -> module.execute(dbId, "SELECT typeof(?)", taggedParams, callback));
    expect(taggedType.getBoolean("ok"), "tagged __psBig bind ok");
    expect("integer".equals(firstString(taggedType)), "tagged __psBig BindValue binds as INTEGER");

    ReadableMap unsafeInt =
        await(callback -> module.execute(dbId, "SELECT 9007199254740993", empty(), callback));
    expect(unsafeInt.getBoolean("ok"), "unsafe INTEGER select ok");
    expect(firstIsLong(unsafeInt, 9007199254740993L),
        "INTEGER past MAX_SAFE_INTEGER maps to Lynx Long (not tagged __psBig)");

    ReadableMap created =
        await(
            callback ->
                module.execute(
                    dbId,
                    "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)",
                    empty(),
                    callback));
    expect(created.getBoolean("ok"), "create table");

    WritableArray batch = Arguments.createArray();
    WritableArray rowA = Arguments.createArray();
    rowA.pushString("alpha");
    batch.pushArray(rowA);
    WritableArray rowB = Arguments.createArray();
    rowB.pushString("beta");
    batch.pushArray(rowB);
    ReadableMap batched =
        await(
            callback ->
                module.executeBatch(dbId, "INSERT INTO items(name) VALUES(?)", batch, callback));
    printEnvelope("executeBatch", batched);
    expect(batched.getBoolean("ok"), "executeBatch ok");
    expect(batched.getDouble("rowsAffected") == 2.0, "executeBatch rowsAffected");

    ReadableMap failed =
        await(callback -> module.execute(dbId, "SELECT * FROM no_such_table", empty(), callback));
    printEnvelope("failure", failed);
    expect(!failed.getBoolean("ok"), "failure envelope ok=false");
    expect(failed.getString("message") != null && !failed.getString("message").isEmpty(),
        "failure message");
    expect(failed.hasKey("code"), "failure code from sqlite extended errcode");

    AtomicBoolean callbackFired = new AtomicBoolean(false);
    CountDownLatch slowDone = new CountDownLatch(1);
    long startNs = System.nanoTime();
    module.execute(
        dbId,
        "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < 400000)"
            + " SELECT count(*) FROM t",
        empty(),
        args -> {
          callbackFired.set(true);
          slowDone.countDown();
        });
    long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNs);
    expect(elapsedMs < 50 && !callbackFired.get(), "execute returns immediately (off JS thread)");
    expect(slowDone.await(30, TimeUnit.SECONDS), "slow execute eventually succeeds");

    ReadableMap closed = await(callback -> module.close(dbId, callback));
    printEnvelope("close", closed);
    expect(closed.getBoolean("ok"), "close ok");

    System.out.println("all Android NativePowerSyncModule RPC checks passed");
  }

  private static WritableArray empty() {
    return Arguments.createArray();
  }

  private static WritableArray stringParams(String value) {
    WritableArray params = Arguments.createArray();
    params.pushString(value);
    return params;
  }

  private static boolean firstIsLong(ReadableMap envelope, long want) {
    if (!envelope.hasKey("rawRows") || envelope.isNull("rawRows")) {
      return false;
    }
    ReadableArray rows = envelope.getArray("rawRows");
    if (rows == null || rows.size() == 0) {
      return false;
    }
    ReadableArray row = rows.getArray(0);
    if (row == null || row.size() == 0 || row.isNull(0)) {
      return false;
    }
    return row.getType(0) == com.lynx.react.bridge.ReadableType.Long && row.getLong(0) == want;
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

  private static String firstString(ReadableMap envelope) {
    if (!envelope.hasKey("rawRows") || envelope.isNull("rawRows")) {
      return null;
    }
    ReadableArray rows = envelope.getArray("rawRows");
    if (rows == null || rows.size() == 0) {
      return null;
    }
    ReadableArray row = rows.getArray(0);
    if (row == null || row.size() == 0 || row.isNull(0)) {
      return null;
    }
    return row.getString(0);
  }

  private static void printEnvelope(String label, ReadableMap envelope) {
    System.out.println("envelope " + label + ": " + envelope);
  }

  private static void expect(boolean cond, String what) {
    if (cond) {
      System.out.println("ok: " + what);
    } else {
      fail(what);
    }
  }

  private static int compareVersion(String actual, String minimum) {
    String[] left = actual.split("\\.");
    String[] right = minimum.split("\\.");
    int n = Math.max(left.length, right.length);
    for (int i = 0; i < n; i++) {
      int a = i < left.length ? parsePart(left[i]) : 0;
      int b = i < right.length ? parsePart(right[i]) : 0;
      if (a != b) {
        return Integer.compare(a, b);
      }
    }
    return 0;
  }

  private static int parsePart(String part) {
    String digits = part.replaceAll("[^0-9].*$", "");
    if (digits.isEmpty()) {
      return 0;
    }
    return Integer.parseInt(digits);
  }

  private interface RpcCall {
    void launch(Callback callback);
  }
}
