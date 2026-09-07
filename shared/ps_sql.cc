#include "ps_sql.h"

#include <sqlite3.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <utility>

#if defined(_WIN32)
#include <io.h>
#include <sys/stat.h>
#else
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#ifndef SQLITE_VERSION_NUMBER
#error "sqlite3.h did not define SQLITE_VERSION_NUMBER"
#endif
#if SQLITE_VERSION_NUMBER < 3044000
#error "powersync-sqlite-core requires SQLite 3.44+"
#endif

#if defined(PS_SQL_LINK_CORE)
extern "C" int sqlite3_powersync_init(sqlite3* db, char** pzErrMsg,
                                      const sqlite3_api_routines* pApi);
#endif

namespace ps_sql {
namespace {

constexpr std::int64_t kMaxSafeInteger = 9007199254740991LL;

using PowersyncInit = int (*)(sqlite3*, char**, const sqlite3_api_routines*);

bool is_directory(const std::string& path) {
#if defined(_WIN32)
  struct _stat st;
  if (_stat(path.c_str(), &st) != 0) {
    return false;
  }
  return (st.st_mode & _S_IFDIR) != 0;
#else
  struct stat st;
  if (stat(path.c_str(), &st) != 0) {
    return false;
  }
  return S_ISDIR(st.st_mode);
#endif
}

std::string join_path(const std::string& dir, const std::string& file) {
  if (dir.empty()) {
    return file;
  }
  const char sep =
#if defined(_WIN32)
      '\\';
#else
      '/';
#endif
  if (dir.back() == '/' || dir.back() == '\\') {
    return dir + file;
  }
  return dir + sep + file;
}

Envelope sqlite_fail(sqlite3* db, const char* fallback) {
  Envelope env;
  env.ok = false;
  if (db != nullptr) {
    const char* msg = sqlite3_errmsg(db);
    env.message = msg != nullptr ? msg : fallback;
    env.code = sqlite3_extended_errcode(db);
  } else {
    env.message = fallback;
  }
  return env;
}

int bind_one(sqlite3_stmt* stmt, int index, const BindValue& value) {
  switch (value.kind) {
    case CellKind::kNull:
      return sqlite3_bind_null(stmt, index);
    case CellKind::kInteger:
      return sqlite3_bind_int64(stmt, index, value.i);
    case CellKind::kFloat:
      return sqlite3_bind_double(stmt, index, value.f);
    case CellKind::kText:
      return sqlite3_bind_text(stmt, index, value.text.c_str(),
                               static_cast<int>(value.text.size()),
                               SQLITE_TRANSIENT);
    case CellKind::kBlob:
      return sqlite3_bind_blob(stmt, index, value.blob.data(),
                               static_cast<int>(value.blob.size()),
                               SQLITE_TRANSIENT);
  }
  return SQLITE_MISUSE;
}

Cell read_cell(sqlite3_stmt* stmt, int col) {
  Cell cell;
  switch (sqlite3_column_type(stmt, col)) {
    case SQLITE_INTEGER: {
      cell.kind = CellKind::kInteger;
      cell.i = sqlite3_column_int64(stmt, col);
      cell.integer_as_bigint =
          cell.i > kMaxSafeInteger || cell.i < -kMaxSafeInteger;
      break;
    }
    case SQLITE_FLOAT:
      cell.kind = CellKind::kFloat;
      cell.f = sqlite3_column_double(stmt, col);
      break;
    case SQLITE_TEXT: {
      cell.kind = CellKind::kText;
      const unsigned char* text = sqlite3_column_text(stmt, col);
      const int bytes = sqlite3_column_bytes(stmt, col);
      if (text != nullptr && bytes > 0) {
        cell.text.assign(reinterpret_cast<const char*>(text),
                         static_cast<std::size_t>(bytes));
      }
      break;
    }
    case SQLITE_BLOB: {
      cell.kind = CellKind::kBlob;
      const void* blob = sqlite3_column_blob(stmt, col);
      const int bytes = sqlite3_column_bytes(stmt, col);
      if (blob != nullptr && bytes > 0) {
        const auto* p = static_cast<const std::uint8_t*>(blob);
        cell.blob.assign(p, p + bytes);
      }
      break;
    }
    case SQLITE_NULL:
    default:
      cell.kind = CellKind::kNull;
      break;
  }
  return cell;
}

class ThreadPool {
 public:
  explicit ThreadPool(unsigned n) {
    if (n < 2) {
      n = 2;
    }
    threads_.reserve(n);
    for (unsigned i = 0; i < n; ++i) {
      threads_.emplace_back([this] { worker(); });
    }
  }

  ~ThreadPool() {
    {
      std::lock_guard<std::mutex> lock(mu_);
      stop_ = true;
    }
    cv_.notify_all();
    for (auto& t : threads_) {
      if (t.joinable()) {
        t.join();
      }
    }
  }

  void post(std::function<void()> job) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      jobs_.push(std::move(job));
    }
    cv_.notify_one();
  }

 private:
  void worker() {
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait(lock, [this] { return stop_ || !jobs_.empty(); });
        if (stop_ && jobs_.empty()) {
          return;
        }
        job = std::move(jobs_.front());
        jobs_.pop();
      }
      job();
    }
  }

  std::mutex mu_;
  std::condition_variable cv_;
  std::queue<std::function<void()>> jobs_;
  std::vector<std::thread> threads_;
  bool stop_ = false;
};

struct Connection {
  sqlite3* db = nullptr;
  std::mutex mu;
};

}  // namespace

Envelope fail(std::string message, std::optional<int> code) {
  Envelope env;
  env.ok = false;
  env.message = std::move(message);
  env.code = code;
  return env;
}

struct Engine::Impl {
  explicit Impl(EngineConfig cfg)
      : config(std::move(cfg)),
        pool(std::max(4u, std::thread::hardware_concurrency())) {}

  ~Impl() {
    std::lock_guard<std::mutex> lock(map_mu);
    for (auto& entry : dbs) {
      if (entry.second && entry.second->db) {
        sqlite3_close(entry.second->db);
        entry.second->db = nullptr;
      }
    }
    dbs.clear();
  }

  Envelope register_auto_extension() {
    std::call_once(core_once, [this] {
      PowersyncInit init = nullptr;
      if (config.core_path.empty()) {
#if defined(PS_SQL_LINK_CORE)
        init = sqlite3_powersync_init;
        if (init == nullptr) {
          core_error = fail("sqlite3_powersync_init is not linked");
          return;
        }
#else
        core_error = fail("sqlite3_powersync_init is not linked");
        return;
#endif
      } else {
#if defined(_WIN32)
        core_error =
            fail("Windows loads powersync-sqlite-core via loadExtension");
        return;
#else
        void* handle =
            dlopen(config.core_path.c_str(), RTLD_NOW | RTLD_GLOBAL);
        if (handle == nullptr) {
          const char* dlerr = dlerror();
          core_error = fail(dlerr != nullptr
                                ? std::string(dlerr)
                                : "failed to dlopen powersync-sqlite-core");
          return;
        }
        void* sym = dlsym(handle, "sqlite3_powersync_init");
        if (sym == nullptr) {
          core_error = fail("sqlite3_powersync_init not found in core library");
          return;
        }
        init = reinterpret_cast<PowersyncInit>(sym);
#endif
      }
      const int rc =
          sqlite3_auto_extension(reinterpret_cast<void (*)(void)>(init));
      if (rc != SQLITE_OK) {
        core_error = fail("sqlite3_auto_extension failed", rc);
      }
    });
    return core_error;
  }

  Envelope load_extension(sqlite3* db) {
    if (config.core_path.empty()) {
      return fail("powersync-sqlite-core path is required for loadExtension");
    }
    int enabled = 0;
    int rc = sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1,
                               &enabled);
    if (rc != SQLITE_OK) {
      return sqlite_fail(db, "ENABLE_LOAD_EXTENSION failed");
    }
    char* ext_err = nullptr;
    rc = sqlite3_load_extension(db, config.core_path.c_str(),
                                "sqlite3_powersync_init", &ext_err);
    if (rc != SQLITE_OK) {
      Envelope env = sqlite_fail(db, "sqlite3_load_extension failed");
      if (ext_err != nullptr) {
        env.message = ext_err;
        sqlite3_free(ext_err);
      }
      return env;
    }
    Envelope ok;
    ok.ok = true;
    return ok;
  }

  Envelope open_sync(const OpenOptions& options) {
    if (options.db_filename.empty()) {
      return fail("dbFilename is required");
    }
    std::string path = options.db_filename;
    const bool absolute =
#if defined(_WIN32)
        path.size() >= 2 && ((path[1] == ':') || path[0] == '\\' || path[0] == '/');
#else
        (path.empty() == false) && path[0] == '/';
#endif
    if (options.db_location.has_value()) {
      const std::string& loc = *options.db_location;
      if (loc.empty() || !is_directory(loc)) {
        return fail("dbLocation does not exist");
      }
      if (!absolute && path != ":memory:" && path.rfind("file:", 0) != 0) {
        path = join_path(loc, options.db_filename);
      }
    }

    if (config.core_load == CoreLoad::kAutoExtension) {
      Envelope core_err = register_auto_extension();
      if (!core_err.message.empty()) {
        return core_err;
      }
    }

    int flags = options.read_only ? SQLITE_OPEN_READONLY
                                  : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    flags |= SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_URI;

    sqlite3* db = nullptr;
    const int rc = sqlite3_open_v2(path.c_str(), &db, flags, nullptr);
    if (rc != SQLITE_OK) {
      Envelope env = sqlite_fail(db, "sqlite3_open_v2 failed");
      if (db != nullptr) {
        sqlite3_close(db);
      }
      return env;
    }

    if (config.core_load == CoreLoad::kLoadExtension) {
      Envelope ext = load_extension(db);
      if (!ext.ok) {
        sqlite3_close(db);
        return ext;
      }
    }

    auto conn = std::make_shared<Connection>();
    conn->db = db;
    const std::string id = "ps-" + std::to_string(next_id.fetch_add(1));
    {
      std::lock_guard<std::mutex> lock(map_mu);
      dbs.emplace(id, conn);
    }
    Envelope env;
    env.ok = true;
    env.db_id = id;
    return env;
  }

  Envelope close_sync(const std::string& db_id) {
    std::shared_ptr<Connection> conn;
    {
      std::lock_guard<std::mutex> lock(map_mu);
      auto it = dbs.find(db_id);
      if (it == dbs.end()) {
        return fail("unknown dbId");
      }
      conn = it->second;
      dbs.erase(it);
    }
    std::lock_guard<std::mutex> db_lock(conn->mu);
    if (conn->db != nullptr) {
      const int rc = sqlite3_close(conn->db);
      if (rc != SQLITE_OK) {
        Envelope env = sqlite_fail(conn->db, "sqlite3_close failed");
        return env;
      }
      conn->db = nullptr;
    }
    Envelope env;
    env.ok = true;
    return env;
  }

  std::shared_ptr<Connection> lookup(const std::string& db_id, Envelope* err) {
    std::lock_guard<std::mutex> lock(map_mu);
    auto it = dbs.find(db_id);
    if (it == dbs.end()) {
      *err = fail("unknown dbId");
      return nullptr;
    }
    return it->second;
  }

  Envelope run_statement(sqlite3* db, const std::string& sql,
                         const std::vector<BindValue>& params) {
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db, sql.c_str(), static_cast<int>(sql.size()),
                                &stmt, nullptr);
    if (rc != SQLITE_OK) {
      return sqlite_fail(db, "sqlite3_prepare_v2 failed");
    }

    for (std::size_t i = 0; i < params.size(); ++i) {
      rc = bind_one(stmt, static_cast<int>(i + 1), params[i]);
      if (rc != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return sqlite_fail(db, "sqlite3_bind failed");
      }
    }

    Envelope env;
    env.ok = true;
    const int cols = sqlite3_column_count(stmt);
    env.column_names.reserve(static_cast<std::size_t>(cols));
    for (int c = 0; c < cols; ++c) {
      const char* name = sqlite3_column_name(stmt, c);
      env.column_names.emplace_back(name != nullptr ? name : "");
    }

    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
      std::vector<Cell> row;
      row.reserve(static_cast<std::size_t>(cols));
      for (int c = 0; c < cols; ++c) {
        row.push_back(read_cell(stmt, c));
      }
      env.raw_rows.push_back(std::move(row));
    }
    if (rc != SQLITE_DONE) {
      Envelope fail_env = sqlite_fail(db, "sqlite3_step failed");
      sqlite3_finalize(stmt);
      return fail_env;
    }

    env.insert_id = sqlite3_last_insert_rowid(db);
    env.rows_affected = sqlite3_changes(db);
    sqlite3_finalize(stmt);
    return env;
  }

  Envelope execute_sync(const std::string& db_id, const std::string& sql,
                        const std::vector<BindValue>& params) {
    Envelope err;
    auto conn = lookup(db_id, &err);
    if (!conn) {
      return err;
    }
    std::lock_guard<std::mutex> db_lock(conn->mu);
    if (conn->db == nullptr) {
      return fail("database is closed");
    }
    return run_statement(conn->db, sql, params);
  }

  Envelope execute_batch_sync(const std::string& db_id, const std::string& sql,
                              const std::vector<std::vector<BindValue>>& rows) {
    Envelope err;
    auto conn = lookup(db_id, &err);
    if (!conn) {
      return err;
    }
    std::lock_guard<std::mutex> db_lock(conn->mu);
    if (conn->db == nullptr) {
      return fail("database is closed");
    }

    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(conn->db, sql.c_str(),
                                static_cast<int>(sql.size()), &stmt, nullptr);
    if (rc != SQLITE_OK) {
      return sqlite_fail(conn->db, "sqlite3_prepare_v2 failed");
    }

    Envelope env;
    env.ok = true;
    const int cols = sqlite3_column_count(stmt);
    env.column_names.reserve(static_cast<std::size_t>(cols));
    for (int c = 0; c < cols; ++c) {
      const char* name = sqlite3_column_name(stmt, c);
      env.column_names.emplace_back(name != nullptr ? name : "");
    }

    std::int64_t rows_affected = 0;
    std::int64_t insert_id = 0;
    for (const auto& params : rows) {
      sqlite3_reset(stmt);
      sqlite3_clear_bindings(stmt);
      for (std::size_t i = 0; i < params.size(); ++i) {
        rc = bind_one(stmt, static_cast<int>(i + 1), params[i]);
        if (rc != SQLITE_OK) {
          sqlite3_finalize(stmt);
          return sqlite_fail(conn->db, "sqlite3_bind failed");
        }
      }
      env.raw_rows.clear();
      while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        std::vector<Cell> row;
        row.reserve(static_cast<std::size_t>(cols));
        for (int c = 0; c < cols; ++c) {
          row.push_back(read_cell(stmt, c));
        }
        env.raw_rows.push_back(std::move(row));
      }
      if (rc != SQLITE_DONE) {
        Envelope fail_env = sqlite_fail(conn->db, "sqlite3_step failed");
        sqlite3_finalize(stmt);
        return fail_env;
      }
      insert_id = sqlite3_last_insert_rowid(conn->db);
      rows_affected += sqlite3_changes(conn->db);
    }
    sqlite3_finalize(stmt);
    env.insert_id = insert_id;
    env.rows_affected = rows_affected;
    return env;
  }

  EngineConfig config;
  ThreadPool pool;
  std::mutex map_mu;
  std::unordered_map<std::string, std::shared_ptr<Connection>> dbs;
  std::atomic<std::uint64_t> next_id{1};
  std::once_flag core_once;
  Envelope core_error;
};

Engine::Engine(EngineConfig config) : impl_(new Impl(std::move(config))) {}

Engine::~Engine() { delete impl_; }

void Engine::open(OpenOptions options, Callback cb) {
  impl_->pool.post([impl = impl_, options = std::move(options),
                    cb = std::move(cb)]() mutable {
    Envelope env;
    try {
      env = impl->open_sync(options);
    } catch (const std::exception& ex) {
      env = fail(ex.what());
    }
    cb(std::move(env));
  });
}

void Engine::close(std::string db_id, Callback cb) {
  impl_->pool.post([impl = impl_, db_id = std::move(db_id),
                    cb = std::move(cb)]() mutable {
    Envelope env;
    try {
      env = impl->close_sync(db_id);
    } catch (const std::exception& ex) {
      env = fail(ex.what());
    }
    cb(std::move(env));
  });
}

void Engine::execute(std::string db_id, std::string sql,
                     std::vector<BindValue> params, Callback cb) {
  impl_->pool.post([impl = impl_, db_id = std::move(db_id), sql = std::move(sql),
                    params = std::move(params), cb = std::move(cb)]() mutable {
    Envelope env;
    try {
      env = impl->execute_sync(db_id, sql, params);
    } catch (const std::exception& ex) {
      env = fail(ex.what());
    }
    cb(std::move(env));
  });
}

void Engine::execute_batch(std::string db_id, std::string sql,
                           std::vector<std::vector<BindValue>> params,
                           Callback cb) {
  impl_->pool.post([impl = impl_, db_id = std::move(db_id), sql = std::move(sql),
                    params = std::move(params), cb = std::move(cb)]() mutable {
    Envelope env;
    try {
      env = impl->execute_batch_sync(db_id, sql, params);
    } catch (const std::exception& ex) {
      env = fail(ex.what());
    }
    cb(std::move(env));
  });
}

}  // namespace ps_sql
