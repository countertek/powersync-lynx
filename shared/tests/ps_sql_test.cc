#include "nativeModule/core_path.h"
#include "nativeModule/db_location.h"
#include "ps_sql.h"
#if defined(_WIN32)
#include "win_utf8.h"
#endif

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <string>

using ps_sql::BindValue;
using ps_sql::CellKind;
using ps_sql::Engine;
using ps_sql::EngineConfig;
using ps_sql::Envelope;
using ps_sql::OpenOptions;

namespace {

int g_failures = 0;

void expect(bool cond, const char* what) {
  if (!cond) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_failures;
  } else {
    std::printf("ok: %s\n", what);
  }
}

Envelope wait_for(const std::function<void(ps_sql::Callback)>& launch) {
  std::mutex mu;
  std::condition_variable cv;
  bool done = false;
  Envelope result;
  launch([&](Envelope env) {
    std::lock_guard<std::mutex> lock(mu);
    result = std::move(env);
    done = true;
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mu);
  cv.wait(lock, [&] { return done; });
  return result;
}

}  // namespace

int main(int argc, char** argv) {
  std::string core_path;
#if defined(_WIN32)
  core_path = ps_sql::ReadEnvVarUtf8(L"POWERSYNC_CORE_PATH");
#else
  if (const char* env_core = std::getenv("POWERSYNC_CORE_PATH");
      env_core != nullptr) {
    core_path = env_core;
  }
#endif
  if (core_path.empty() && argc > 1 && argv[1] != nullptr) {
    core_path = argv[1];
  }
  if (core_path.empty()) {
    std::fprintf(stderr, "POWERSYNC_CORE_PATH or argv[1] required\n");
    return 2;
  }

  EngineConfig config;
#if defined(_WIN32)
  config.core_load = ps_sql::CoreLoad::kLoadExtension;
#else
  config.core_load = ps_sql::CoreLoad::kAutoExtension;
#endif
  config.core_path = core_path;
  Engine engine(config);

  Envelope opened = wait_for([&](ps_sql::Callback cb) {
    OpenOptions options;
    options.db_filename = ":memory:";
    engine.open(options, std::move(cb));
  });
  expect(opened.ok, "open success ok=true");
  expect(!opened.db_id.empty(), "open returns opaque dbId");
  expect(opened.db_id.rfind("ps-", 0) == 0, "dbId is opaque ps-* string");

  const std::string db_id = opened.db_id;

  Envelope version = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT powersync_rs_version()", {}, std::move(cb));
  });
  expect(version.ok, "core-load: powersync_rs_version ok");
  expect(version.column_names.size() == 1, "core-load: one column");
  expect(!version.raw_rows.empty() &&
             version.raw_rows[0][0].kind == CellKind::kText &&
             !version.raw_rows[0][0].text.empty(),
         "core-load: version text cell");

  BindValue snowflake;
  snowflake.kind = CellKind::kText;
  snowflake.text = "9007199254740993";
  Envelope snow_type = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT typeof(?)", {snowflake}, std::move(cb));
  });
  expect(snow_type.ok && !snow_type.raw_rows.empty() &&
             snow_type.raw_rows[0][0].kind == CellKind::kText &&
             snow_type.raw_rows[0][0].text == "text",
         "string snowflake BindValue stays TEXT");

  Envelope big_int = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT 9007199254740993", {}, std::move(cb));
  });
  expect(big_int.ok && !big_int.raw_rows.empty() &&
             big_int.raw_rows[0][0].kind == CellKind::kInteger &&
             big_int.raw_rows[0][0].i == 9007199254740993LL &&
             big_int.raw_rows[0][0].integer_as_bigint,
         "INTEGER past MAX_SAFE_INTEGER sets integer_as_bigint");

  Envelope created = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, blob BLOB)",
                   {}, std::move(cb));
  });
  expect(created.ok, "create table");

  BindValue name;
  name.kind = CellKind::kText;
  name.text = "alpha";
  BindValue blob;
  blob.kind = CellKind::kBlob;
  blob.blob = {1, 2, 3, 4};
  Envelope inserted = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "INSERT INTO items(name, blob) VALUES(?, ?)",
                   {name, blob}, std::move(cb));
  });
  expect(inserted.ok, "insert ok");
  expect(inserted.insert_id == 1, "insertId");
  expect(inserted.rows_affected == 1, "rowsAffected");

  Envelope selected = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT id, name, blob FROM items", {}, std::move(cb));
  });
  expect(selected.ok, "select ok");
  expect(selected.column_names.size() == 3, "columnNames length");
  expect(selected.raw_rows.size() == 1, "rawRows length");
  expect(selected.raw_rows[0][1].text == "alpha", "text cell");
  expect(selected.raw_rows[0][2].blob.size() == 4, "blob cell");

  BindValue n1;
  n1.kind = CellKind::kText;
  n1.text = "b";
  BindValue n2;
  n2.kind = CellKind::kText;
  n2.text = "c";
  Envelope batched = wait_for([&](ps_sql::Callback cb) {
    engine.execute_batch(db_id, "INSERT INTO items(name) VALUES(?)",
                         {{n1}, {n2}}, std::move(cb));
  });
  expect(batched.ok, "executeBatch ok");
  expect(batched.rows_affected == 2, "executeBatch rowsAffected");

  BindValue empty_blob;
  empty_blob.kind = CellKind::kBlob;
  Envelope empty_typeof = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT typeof(?)", {empty_blob}, std::move(cb));
  });
  expect(empty_typeof.ok && !empty_typeof.raw_rows.empty() &&
             empty_typeof.raw_rows[0][0].kind == CellKind::kText &&
             empty_typeof.raw_rows[0][0].text == "blob",
         "empty BLOB BindValue stays BLOB, not NULL");
  Envelope empty_isnull = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT ? IS NULL", {empty_blob}, std::move(cb));
  });
  expect(empty_isnull.ok && !empty_isnull.raw_rows.empty() &&
             empty_isnull.raw_rows[0][0].kind == CellKind::kInteger &&
             empty_isnull.raw_rows[0][0].i == 0,
         "empty BLOB is not SQL NULL");

  Envelope uniq = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "CREATE TABLE ids(id INTEGER PRIMARY KEY)", {},
                   std::move(cb));
  });
  expect(uniq.ok, "unique table");
  BindValue id1;
  id1.kind = CellKind::kInteger;
  id1.i = 1;
  Envelope torn = wait_for([&](ps_sql::Callback cb) {
    engine.execute_batch(db_id, "INSERT INTO ids(id) VALUES(?)", {{id1}, {id1}},
                         std::move(cb));
  });
  expect(!torn.ok, "executeBatch unique violation is a failure envelope");
  Envelope remaining = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT count(*) FROM ids", {}, std::move(cb));
  });
  expect(remaining.ok && !remaining.raw_rows.empty() &&
             remaining.raw_rows[0][0].kind == CellKind::kInteger &&
             remaining.raw_rows[0][0].i == 0,
         "executeBatch rolls back earlier rows on first error");

  Envelope bad_sql = wait_for([&](ps_sql::Callback cb) {
    engine.execute_batch(db_id, "NOT VALID SQL", {{}}, std::move(cb));
  });
  expect(!bad_sql.ok, "executeBatch invalid SQL is a failure envelope");
  expect(bad_sql.message.find("syntax") != std::string::npos,
         "executeBatch prepare failure keeps sqlite errmsg");

  Envelope failed = wait_for([&](ps_sql::Callback cb) {
    engine.execute(db_id, "SELECT * FROM no_such_table", {}, std::move(cb));
  });
  expect(!failed.ok, "failure envelope ok=false");
  expect(!failed.message.empty(), "failure message from sqlite3_errmsg");
  expect(failed.code.has_value(), "failure code from sqlite3_extended_errcode");

  const char* slow_sql =
      "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x < "
      "400000) SELECT count(*) FROM t";
  std::mutex mu;
  std::condition_variable cv;
  bool called = false;
  Envelope slow_env;
  const auto start = std::chrono::steady_clock::now();
  engine.execute(db_id, slow_sql, {}, [&](Envelope env) {
    std::lock_guard<std::mutex> lock(mu);
    slow_env = std::move(env);
    called = true;
    cv.notify_one();
  });
  const auto elapsed = std::chrono::steady_clock::now() - start;
  const auto elapsed_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
  expect(elapsed_ms < 50, "execute returns immediately (off JS thread)");
  expect(!called, "callback not invoked before return");
  {
    std::unique_lock<std::mutex> lock(mu);
    cv.wait(lock, [&] { return called; });
  }
  expect(slow_env.ok, "slow execute eventually succeeds");

  Envelope closed = wait_for([&](ps_sql::Callback cb) {
    engine.close(db_id, std::move(cb));
  });
  expect(closed.ok, "close ok");

  Envelope unknown = wait_for([&](ps_sql::Callback cb) {
    engine.execute("missing", "SELECT 1", {}, std::move(cb));
  });
  expect(!unknown.ok, "unknown dbId does not throw");
  expect(unknown.message.find("dbId") != std::string::npos, "unknown dbId message");

  {
    Engine draining(config);
    Envelope opened_drain = wait_for([&](ps_sql::Callback cb) {
      OpenOptions options;
      options.db_filename = ":memory:";
      draining.open(options, std::move(cb));
    });
    expect(opened_drain.ok, "drain engine open");
    draining.execute(opened_drain.db_id, slow_sql, {}, [](Envelope) {});
  }
  expect(true, "engine destructor drains queued SQL before teardown");

  {
    using ps_sql::CorePathOptions;
    using ps_sql::CorePlatform;
    using ps_sql::ResolveCorePath;

    // 1. POWERSYNC_CORE_PATH env var takes precedence on both macOS and Windows.
    CorePathOptions env_mac;
    env_mac.platform = CorePlatform::kMacOS;
    env_mac.env_core_path = "/custom/override/libpowersync.dylib";
    env_mac.module_dir = "/App.app/Contents/MacOS";
    env_mac.core_filename = "libpowersync_aarch64.macos.dylib";
    env_mac.file_exists = [](const std::string&) { return true; };
    expect(ResolveCorePath(env_mac) == "/custom/override/libpowersync.dylib",
           "core-path: POWERSYNC_CORE_PATH overrides macOS probes");

    CorePathOptions env_win;
    env_win.platform = CorePlatform::kWindows;
    env_win.env_core_path = "C:\\custom\\powersync_x64.dll";
    env_win.module_dir = "C:\\app";
    env_win.core_filename = "powersync_x64.dll";
    expect(ResolveCorePath(env_win) == "C:\\custom\\powersync_x64.dll",
           "core-path: POWERSYNC_CORE_PATH overrides Windows probe");

    // 2. macOS prefers sibling <ModuleDirectory> over ../Frameworks when both exist.
    CorePathOptions mac_sibling;
    mac_sibling.platform = CorePlatform::kMacOS;
    mac_sibling.module_dir = "/dist/macos/arm64";
    mac_sibling.core_filename = "libpowersync_aarch64.macos.dylib";
    mac_sibling.file_exists = [](const std::string& p) {
      return p == "/dist/macos/arm64/libpowersync_aarch64.macos.dylib" ||
             p == "/dist/macos/arm64/../Frameworks/libpowersync_aarch64.macos.dylib";
    };
    expect(ResolveCorePath(mac_sibling) ==
               "/dist/macos/arm64/libpowersync_aarch64.macos.dylib",
           "core-path: macOS prefers sibling when present");

    // 3. macOS falls back to <ModuleDirectory>/../Frameworks when sibling is absent.
    CorePathOptions mac_frameworks;
    mac_frameworks.platform = CorePlatform::kMacOS;
    mac_frameworks.module_dir = "/MyApp.app/Contents/MacOS";
    mac_frameworks.core_filename = "libpowersync_aarch64.macos.dylib";
    mac_frameworks.file_exists = [](const std::string& p) {
      return p == "/MyApp.app/Contents/MacOS/../Frameworks/libpowersync_aarch64.macos.dylib";
    };
    expect(ResolveCorePath(mac_frameworks) ==
               "/MyApp.app/Contents/MacOS/../Frameworks/libpowersync_aarch64.macos.dylib",
           "core-path: macOS falls back to ../Frameworks when sibling missing");

    // 4. macOS returns sibling path when neither exists (clear downstream error path).
    CorePathOptions mac_missing;
    mac_missing.platform = CorePlatform::kMacOS;
    mac_missing.module_dir = "/missing/dir/";
    mac_missing.core_filename = "libpowersync_aarch64.macos.dylib";
    mac_missing.file_exists = [](const std::string&) { return false; };
    expect(ResolveCorePath(mac_missing) ==
               "/missing/dir/libpowersync_aarch64.macos.dylib",
           "core-path: macOS returns sibling fallback when neither exists");

    // 5. Real filesystem check mimicking a macOS .app bundle layout.
    namespace fs = std::filesystem;
    const fs::path bundle_root =
        fs::temp_directory_path() / "ps_lynx_core_path_test.app";
    std::error_code ec;
    fs::remove_all(bundle_root, ec);
    const fs::path macos_dir = bundle_root / "Contents" / "MacOS";
    const fs::path fw_dir = bundle_root / "Contents" / "Frameworks";
    fs::create_directories(macos_dir, ec);
    fs::create_directories(fw_dir, ec);
    const fs::path fw_dylib = fw_dir / "libpowersync_aarch64.macos.dylib";
    {
      std::ofstream f(fw_dylib);
      f << "stub";
    }
    CorePathOptions mac_fs;
    mac_fs.platform = CorePlatform::kMacOS;
    mac_fs.module_dir = macos_dir.string();
    mac_fs.core_filename = "libpowersync_aarch64.macos.dylib";
    mac_fs.file_exists = [](const std::string& p) {
      std::error_code inner_ec;
      return fs::is_regular_file(p, inner_ec);
    };
    const std::string resolved_fs = ResolveCorePath(mac_fs);
    expect(fs::equivalent(resolved_fs, fw_dylib, ec),
           "core-path: real filesystem macOS .app resolves Contents/Frameworks dylib");
    fs::remove_all(bundle_root, ec);

    // 6. Windows resolves <ModuleDirectory>\powersync_x64.dll.
    CorePathOptions win_sibling;
    win_sibling.platform = CorePlatform::kWindows;
    win_sibling.module_dir = "C:\\Program Files\\MyApp";
    win_sibling.core_filename = "powersync_x64.dll";
    expect(ResolveCorePath(win_sibling) ==
               "C:\\Program Files\\MyApp\\powersync_x64.dll",
           "core-path: Windows resolves sibling powersync_x64.dll");
  }

  // Default desktop dbLocation resolution, recursive creation, and UTF-8 paths.
  {
    using ps_sql::DbLocationPlatform;
    using ps_sql::DefaultDbLocationOptions;
    using ps_sql::EnsureDirectoryRecursive;
    using ps_sql::NeedsDefaultDbLocation;
    using ps_sql::ResolveAndCreateDefaultDbLocation;
    using ps_sql::ResolveDefaultDbLocation;
    using ps_sql::SanitizeAppName;
    namespace fs = std::filesystem;

    // 1. NeedsDefaultDbLocation classification
    expect(!NeedsDefaultDbLocation("", DbLocationPlatform::kMacOS),
           "db-location: empty filename does not use default dir");
    expect(!NeedsDefaultDbLocation(":memory:", DbLocationPlatform::kMacOS),
           "db-location: :memory: does not use default dir");
    expect(!NeedsDefaultDbLocation("file:test?mode=memory",
                                   DbLocationPlatform::kMacOS),
           "db-location: file: URI does not use default dir");
    expect(!NeedsDefaultDbLocation("/abs/app.db", DbLocationPlatform::kMacOS),
           "db-location: POSIX absolute path does not use default dir");
    expect(!NeedsDefaultDbLocation("C:\\abs\\app.db",
                                   DbLocationPlatform::kWindows),
           "db-location: Windows drive path does not use default dir");
    expect(!NeedsDefaultDbLocation("\\\\server\\share\\app.db",
                                   DbLocationPlatform::kWindows),
           "db-location: Windows UNC path does not use default dir");
    expect(NeedsDefaultDbLocation("app.db", DbLocationPlatform::kMacOS),
           "db-location: relative macOS filename uses default dir");
    expect(NeedsDefaultDbLocation("app.db", DbLocationPlatform::kWindows),
           "db-location: relative Windows filename uses default dir");
    expect(NeedsDefaultDbLocation("テスト-café/app.db",
                                  DbLocationPlatform::kMacOS),
           "db-location: relative UTF-8 filename uses default dir");

    // 2. SanitizeAppName
    expect(SanitizeAppName("com.example.MyApp") == "com.example.MyApp",
           "db-location: preserves dotted bundle id");
    expect(SanitizeAppName("a/b\\c") == "a_b_c",
           "db-location: sanitizes path separators");
    expect(SanitizeAppName("..").empty(),
           "db-location: rejects dotdot app name");
    expect(SanitizeAppName("  MyApp. ").compare("MyApp") == 0,
           "db-location: trims whitespace and trailing dot");
    expect(SanitizeAppName("アプリ-café") == "アプリ-café",
           "db-location: preserves UTF-8 app name");

    // 3. macOS resolution priority: CFBundleIdentifier > exe > fallback
    DefaultDbLocationOptions mac_bundle;
    mac_bundle.platform = DbLocationPlatform::kMacOS;
    mac_bundle.base_dir = "/Users/alice";
    mac_bundle.bundle_id = "com.example.Demo";
    mac_bundle.executable_name = "demo-bin";
    expect(ResolveDefaultDbLocation(mac_bundle) ==
               "/Users/alice/Library/Application Support/com.example.Demo",
           "db-location: macOS prefers CFBundleIdentifier");

    DefaultDbLocationOptions mac_exe;
    mac_exe.platform = DbLocationPlatform::kMacOS;
    mac_exe.base_dir = "/Users/alice";
    mac_exe.executable_name = "demo-bin";
    expect(ResolveDefaultDbLocation(mac_exe) ==
               "/Users/alice/Library/Application Support/demo-bin",
           "db-location: macOS falls back to executable name");

    DefaultDbLocationOptions mac_fallback;
    mac_fallback.platform = DbLocationPlatform::kMacOS;
    mac_fallback.base_dir = "/Users/alice";
    expect(ResolveDefaultDbLocation(mac_fallback) ==
               "/Users/alice/Library/Application Support/powersync-lynx",
           "db-location: macOS falls back to powersync-lynx");

    // 4. Windows resolution priority: exe stem > fallback
    DefaultDbLocationOptions win_exe;
    win_exe.platform = DbLocationPlatform::kWindows;
    win_exe.base_dir = "C:\\Users\\テスト\\AppData\\Local";
    win_exe.executable_name = "MyApp";
    expect(ResolveDefaultDbLocation(win_exe) ==
               "C:\\Users\\テスト\\AppData\\Local\\MyApp",
           "db-location: Windows uses LOCALAPPDATA + exe stem");

    DefaultDbLocationOptions win_fallback;
    win_fallback.platform = DbLocationPlatform::kWindows;
    win_fallback.base_dir = "C:\\Users\\Alice\\AppData\\Local";
    expect(ResolveDefaultDbLocation(win_fallback) ==
               "C:\\Users\\Alice\\AppData\\Local\\powersync-lynx",
           "db-location: Windows falls back to powersync-lynx");

    DefaultDbLocationOptions empty_base;
    empty_base.platform = DbLocationPlatform::kMacOS;
    expect(ResolveDefaultDbLocation(empty_base).empty(),
           "db-location: empty base_dir returns empty string");

    // 5. Recursive auto-creation & non-ASCII UTF-8 directory + db filename
    const fs::path test_root =
        fs::temp_directory_path() / "ps_lynx_db_location_test";
    std::error_code ec;
    fs::remove_all(test_root, ec);

    const fs::path utf8_base = test_root / fs::u8path("ホーム-café");
    DefaultDbLocationOptions fs_opts;
    fs_opts.platform = ps_sql::CurrentDbLocationPlatform();
    fs_opts.base_dir = utf8_base.u8string();
    fs_opts.bundle_id = "テスト-café";
    fs_opts.executable_name = "テスト-café";

    std::string dir_err;
    const std::string created_dir =
        ResolveAndCreateDefaultDbLocation(&dir_err, &fs_opts);
    expect(!created_dir.empty() && dir_err.empty(),
           "db-location: recursively creates UTF-8 default app-data dir");
    expect(fs::is_directory(fs::u8path(created_dir), ec),
           "db-location: created UTF-8 default dir exists on disk");

    // Idempotent second call when directory already exists
    const std::string created_again =
        ResolveAndCreateDefaultDbLocation(&dir_err, &fs_opts);
    expect(created_again == created_dir && dir_err.empty(),
           "db-location: repeated creation on existing dir succeeds");

    // Open a non-ASCII UTF-8 db inside the auto-created UTF-8 default dir
    const std::string utf8_db_name = "テスト-café.db";
    Envelope utf8_open = wait_for([&](ps_sql::Callback cb) {
      OpenOptions opts;
      opts.db_filename = utf8_db_name;
      opts.db_location = created_dir;
      engine.open(opts, std::move(cb));
    });
    expect(utf8_open.ok, "db-location: open UTF-8 db in UTF-8 default dir ok");
    if (utf8_open.ok) {
      Envelope ver = wait_for([&](ps_sql::Callback cb) {
        engine.execute(utf8_open.db_id, "SELECT powersync_rs_version()", {},
                       std::move(cb));
      });
      expect(ver.ok && !ver.raw_rows.empty(),
             "db-location: powersync-sqlite-core works in UTF-8 db path");
      Envelope tbl = wait_for([&](ps_sql::Callback cb) {
        engine.execute(utf8_open.db_id,
                       "CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('こんにちは café')",
                       {}, std::move(cb));
      });
      expect(tbl.ok, "db-location: write UTF-8 data to UTF-8 db file ok");
      wait_for([&](ps_sql::Callback cb) {
        engine.close(utf8_open.db_id, std::move(cb));
      });
      const fs::path expected_db =
          fs::u8path(created_dir) / fs::u8path(utf8_db_name);
      expect(fs::is_regular_file(expected_db, ec),
             "db-location: UTF-8 db file persisted in resolved dir");
    }

    // 6. Failure when default directory path collides with an existing file
    const fs::path blocker_file = test_root / "not_a_dir";
    {
      std::ofstream f(blocker_file);
      f << "file";
    }
    std::string collide_err;
    expect(!EnsureDirectoryRecursive(blocker_file.u8string(), &collide_err),
           "db-location: EnsureDirectoryRecursive fails on existing file");
    expect(!collide_err.empty(),
           "db-location: collision returns non-empty error message");

    // 7. Explicit dbLocation (existing succeeds, missing fails), absolute path,
    //    :memory:, and file: URI remain intact.
    const fs::path explicit_dir = test_root / fs::u8path("explicit-テスト");
    fs::create_directories(explicit_dir, ec);
    Envelope explicit_ok = wait_for([&](ps_sql::Callback cb) {
      OpenOptions opts;
      opts.db_filename = "explicit.db";
      opts.db_location = explicit_dir.u8string();
      engine.open(opts, std::move(cb));
    });
    expect(explicit_ok.ok, "db-location: explicit existing UTF-8 dbLocation ok");
    if (explicit_ok.ok) {
      wait_for([&](ps_sql::Callback cb) {
        engine.close(explicit_ok.db_id, std::move(cb));
      });
      expect(fs::is_regular_file(explicit_dir / "explicit.db", ec),
             "db-location: explicit dbLocation stores file inside dir");
    }

    Envelope explicit_missing = wait_for([&](ps_sql::Callback cb) {
      OpenOptions opts;
      opts.db_filename = "app.db";
      opts.db_location = (test_root / "does_not_exist").u8string();
      engine.open(opts, std::move(cb));
    });
    expect(!explicit_missing.ok &&
               explicit_missing.message.find("dbLocation") != std::string::npos,
           "db-location: missing explicit dbLocation still fails");

    const fs::path abs_db = explicit_dir / "absolute.db";
    Envelope abs_open = wait_for([&](ps_sql::Callback cb) {
      OpenOptions opts;
      opts.db_filename = abs_db.u8string();
      engine.open(opts, std::move(cb));
    });
    expect(abs_open.ok, "db-location: absolute path opens directly");
    if (abs_open.ok) {
      wait_for([&](ps_sql::Callback cb) {
        engine.close(abs_open.db_id, std::move(cb));
      });
      expect(fs::is_regular_file(abs_db, ec),
             "db-location: absolute path file created at exact path");
    }

    Envelope uri_open = wait_for([&](ps_sql::Callback cb) {
      OpenOptions opts;
      opts.db_filename = "file:ps_uri_test?mode=memory&cache=shared";
      engine.open(opts, std::move(cb));
    });
    expect(uri_open.ok, "db-location: file: URI opens cleanly");
    if (uri_open.ok) {
      wait_for([&](ps_sql::Callback cb) {
        engine.close(uri_open.db_id, std::move(cb));
      });
    }

#if !defined(_WIN32)
    // 8. Live host resolution sanity check with isolated HOME
    const char* prev_home = std::getenv("HOME");
    std::string saved_home = prev_home != nullptr ? prev_home : "";
    const fs::path fake_home = test_root / "fake_home";
    fs::create_directories(fake_home, ec);
    setenv("HOME", fake_home.c_str(), 1);
    std::string live_err;
    const std::string live_dir = ResolveAndCreateDefaultDbLocation(&live_err);
    if (prev_home != nullptr) {
      setenv("HOME", saved_home.c_str(), 1);
    } else {
      unsetenv("HOME");
    }
    expect(!live_dir.empty() && live_err.empty(),
           "db-location: live host ResolveAndCreateDefaultDbLocation succeeds");
    expect(live_dir.rfind(fake_home.string(), 0) == 0,
           "db-location: live host path rooted under HOME");
#if defined(__APPLE__)
    expect(live_dir.find("/Library/Application Support/") != std::string::npos,
           "db-location: macOS live path uses Library/Application Support");
#endif
    expect(fs::is_directory(live_dir, ec),
           "db-location: live host directory created on disk");
#endif

    fs::remove_all(test_root, ec);
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all native SQL RPC checks passed\n");
  return 0;
}
