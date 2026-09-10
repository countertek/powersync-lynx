// @ts-nocheck
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function packedPaths(tarball) {
  const listing = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" });
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ""));
}

test("packed tarball ships iOS build inputs and omits host/build residue", async () => {
  const dest = await mkdtemp(path.join(tmpdir(), "ps-lynx-pack-"));
  try {
    execFileSync("node", ["scripts/fetch-native-deps.mjs", "--sqlite"], {
      cwd: root,
      stdio: "pipe",
    });
    assert.equal(
      existsSync(path.join(root, "ios/src/ps_sql.cc")),
      false,
      "fetch-native-deps must not materialize ios/src/ps_sql.cc",
    );
    assert.equal(
      existsSync(path.join(root, "ios/src/ps_sql.h")),
      false,
      "fetch-native-deps must not materialize ios/src/ps_sql.h",
    );
    execFileSync("node", ["scripts/bundle-web-host-factory.mjs"], { cwd: root, stdio: "pipe" });
    const packed = execFileSync("pnpm", ["pack", "--pack-destination", dest, "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    const tarball = packed
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".tgz"));
    assert.ok(tarball, packed);
    const archive = path.isAbsolute(tarball) ? tarball : path.join(dest, path.basename(tarball));
    const files = packedPaths(archive);
    const has = (name) =>
      files.includes(name) || files.some((file) => file === name || file.startsWith(`${name}/`));

    assert.equal(
      has("scripts/fetch-native-deps.mjs"),
      true,
      "podspec prepare_command needs fetch-native-deps.mjs",
    );
    assert.equal(has("third_party/sqlite/sqlite3.c"), true, "podspec source_files needs sqlite3.c");
    assert.equal(has("third_party/sqlite/sqlite3.h"), true, "podspec source_files needs sqlite3.h");
    assert.equal(has("ios/powersync-lynx.podspec"), true);
    assert.equal(
      files.includes("powersync-lynx.podspec"),
      false,
      "published layout is one canonical ios/powersync-lynx.podspec, not a root duplicate",
    );
    assert.equal(
      has("shared/ps_sql.cc"),
      true,
      "canonical shared/ps_sql.cc must ship for the CocoaPods compile unit",
    );
    assert.equal(
      has("shared/ps_sql.h"),
      true,
      "canonical shared/ps_sql.h must ship for the CocoaPods compile unit",
    );
    assert.equal(
      has("ios/src/ps_sql_engine.cc"),
      true,
      "CocoaPods compile unit ios/src/ps_sql_engine.cc must ship",
    );
    assert.equal(
      has("ios/src/ps_sql.cc"),
      false,
      "must not ship a materialized ios/src copy of ps_sql.cc",
    );
    assert.equal(
      has("ios/src/ps_sql.h"),
      false,
      "must not ship a materialized ios/src copy of ps_sql.h",
    );
    assert.equal(
      has("ios/src/sqlite3.c"),
      true,
      "canonical ios/ podspec compiles sqlite3.c from ios/src (symlink or copy)",
    );
    assert.equal(
      has("ios/src/sqlite3.h"),
      true,
      "canonical ios/ podspec compiles sqlite3.h from ios/src (symlink or copy)",
    );
    assert.equal(
      has("ios/src/NativeSyncHttp.h"),
      true,
      "iOS Native Module HTTP lives in NativeSyncHttp.h",
    );
    assert.equal(
      has("ios/src/NativeSyncHttp.mm"),
      true,
      "iOS Native Module HTTP lives in NativeSyncHttp.mm",
    );
    assert.equal(
      has("android/src/main/java/com/powersync/lynx/NativeSyncHttp.java"),
      true,
      "Android Native Module HTTP lives in NativeSyncHttp.java",
    );
    assert.equal(
      has("android/src/main/java/com/powersync/lynx/PsSqlEngine.java"),
      true,
      "Android SQL JNI binder Java seam must ship",
    );
    assert.equal(
      has("android/src/main/cpp/ps_sql_jni.cc"),
      true,
      "Android SQL JNI binder must ship",
    );
    assert.equal(
      has("android/src/main/cpp/utf8_hold_jni.cc"),
      true,
      "Android UTF-8 hold JNI must ship",
    );
    assert.equal(
      has("android/src/main/cpp/CMakeLists.txt"),
      true,
      "Android NDK CMake for ps_sql must ship",
    );
    assert.equal(
      has("shared/sync_http_policy.h"),
      true,
      "idle-complete / streaming timeouts live in shared/sync_http_policy.h",
    );
    assert.equal(
      has("shared/utf8_hold.h"),
      true,
      "native incomplete UTF-8 hold lives in shared/utf8_hold.h",
    );
    assert.equal(
      has("shared/sync_http_session.h"),
      true,
      "NativeSyncHttp session contract lives in shared/sync_http_session.h",
    );
    assert.equal(
      has("android/src/main/cpp/sync_http_session_jni.cc"),
      true,
      "Android session JNI must ship",
    );
    assert.equal(
      has("android/src/main/java/com/powersync/lynx/SyncHttpSession.java"),
      true,
      "Android SyncHttpSession JNI wrapper must ship",
    );
    assert.equal(
      has("android/src/main/java/com/powersync/lynx/SyncHttpPolicy.java"),
      true,
      "Android compiles generated SyncHttpPolicy.java from the shared header",
    );
    assert.equal(
      has("scripts/gen-sync-http-policy-java.mjs"),
      true,
      "Android policy generator must ship so the committed Java can be regenerated",
    );
    assert.equal(
      has("ios/src/IdleCompleteHttp.mm"),
      true,
      "iOS NativePowerSyncModule.httpFetch needs IdleCompleteHttp.mm",
    );
    assert.equal(
      has("ios/src/StreamingHttp.h"),
      true,
      "iOS incremental /sync/stream needs StreamingHttp.h",
    );
    assert.equal(
      has("ios/src/StreamingHttp.mm"),
      true,
      "iOS incremental /sync/stream needs StreamingHttp.mm",
    );
    assert.equal(
      has("android/src/main/java/com/powersync/lynx/StreamingHttp.java"),
      true,
      "Android incremental /sync/stream needs StreamingHttp.java",
    );
    assert.equal(
      has("ios/src/NativePowerSyncModule.mm"),
      true,
      "iOS NativePowerSyncModule sources ship for Autolink",
    );
    assert.equal(
      has("dist/web-host/factory.js"),
      true,
      "attach factory URL needs the bundled ESM entry",
    );
    assert.equal(
      has("android/consumer-rules.pro"),
      true,
      "Android Autolink consumer ProGuard rules must ship",
    );

    const packedLynxLib = JSON.parse(
      execFileSync("tar", ["xzf", archive, "-O", "package/lynx.lib.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(packedLynxLib.platforms?.ios?.sourceDir, "ios");
    assert.equal(
      Object.hasOwn(packedLynxLib.platforms?.ios ?? {}, "podspecPath"),
      false,
      "Autolink uses the first .podspec under ios/",
    );

    assert.equal(
      files.some((file) => file.startsWith("android/host/")),
      false,
      "android host test stubs must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("shared/build/")),
      false,
      "shared/build residue must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("ios/tests/")),
      false,
      "ios test harness must not ship",
    );
    assert.equal(
      files.some((file) => file.startsWith("shared/tests/")),
      false,
      "shared C++ tests must not ship",
    );
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("iOS podspec compiles shared/ps_sql via src/ps_sql_engine.cc; test-ios uses otool -D", () => {
  const podspec = readFileSync(path.join(root, "ios/powersync-lynx.podspec"), "utf8");
  assert.equal(
    podspec.includes("src/**/*.{h,m,mm,c,cc}"),
    true,
    "podspec source_files must stay under PODS_TARGET_SRCROOT (ios/src)",
  );
  assert.equal(
    /source_files\s*=\s*'[^']*\.\.\/shared\/ps_sql/.test(podspec),
    false,
    "CocoaPods drops parent-path source_files; do not list ../shared/ps_sql there",
  );
  assert.equal(
    podspec.includes("exclude_files = 'src/ps_sql.{cc,h}'"),
    true,
    "podspec must keep leftover ios/src engine copies out of the target",
  );
  assert.doesNotMatch(
    podspec,
    /materializeIosSrcCompileInputs/,
    "podspec must not depend on iOS ps_sql materialization",
  );

  const engineUnit = readFileSync(path.join(root, "ios/src/ps_sql_engine.cc"), "utf8");
  assert.match(engineUnit, /#include "ps_sql\.cc"/, "pod compile unit must include canonical shared/ps_sql.cc");
  assert.doesNotMatch(
    engineUnit,
    /namespace\s+ps_sql/,
    "pod compile unit must not duplicate the engine",
  );

  const fetchScript = readFileSync(path.join(root, "scripts/fetch-native-deps.mjs"), "utf8");
  assert.match(fetchScript, /removeStaleIosPsSqlCopies/);
  assert.doesNotMatch(fetchScript, /materializeIosSrcCompileInputs/);
  assert.doesNotMatch(fetchScript, /materializeRegularFile\(path\.join\(ROOT, 'shared', 'ps_sql/);

  const makefile = readFileSync(path.join(root, "Makefile"), "utf8");
  assert.match(makefile, /otool -D/, "make test-ios must discover the core dylib id with otool -D");
  assert.doesNotMatch(
    makefile,
    /\/Users\/runner\/work\/powersync-sqlite-core/,
    "make test-ios must not hard-code the CI runner core dylib install name",
  );
  assert.match(makefile, /JNI_OS_INCLUDE := linux/, "make test JNI includes linux on Linux");
  assert.match(makefile, /JNI_OS_INCLUDE := darwin/, "make test JNI includes darwin on Darwin");
  assert.match(
    makefile,
    /include\/\$\(JNI_OS_INCLUDE\)/,
    "JNI_CFLAGS must select the host JNI include dir",
  );
  assert.equal(
    makefile.includes("$(JAVA_HOME)/include/linux"),
    false,
    "JNI_CFLAGS must not hard-code include/linux",
  );
  assert.match(
    makefile,
    /ios\/src\/ps_sql_engine\.cc/,
    "make test must compile the CocoaPods ps_sql_engine.cc unit",
  );
});
