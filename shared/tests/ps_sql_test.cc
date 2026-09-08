#include "ps_sql.h"

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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
  const char* core_path = std::getenv("POWERSYNC_CORE_PATH");
  if (core_path == nullptr && argc > 1) {
    core_path = argv[1];
  }
  if (core_path == nullptr || std::strlen(core_path) == 0) {
    std::fprintf(stderr, "POWERSYNC_CORE_PATH or argv[1] required\n");
    return 2;
  }

  EngineConfig config;
  config.core_load = ps_sql::CoreLoad::kAutoExtension;
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

  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all native SQL RPC checks passed\n");
  return 0;
}
