#ifndef POWERSYNC_LYNX_PS_SQL_H_
#define POWERSYNC_LYNX_PS_SQL_H_

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace ps_sql {

enum class CellKind { kNull, kInteger, kFloat, kText, kBlob };

struct Cell {
  CellKind kind = CellKind::kNull;
  std::int64_t i = 0;
  double f = 0;
  std::string text;
  std::vector<std::uint8_t> blob;
  bool integer_as_bigint = false;
};

struct BindValue {
  CellKind kind = CellKind::kNull;
  std::int64_t i = 0;
  double f = 0;
  std::string text;
  std::vector<std::uint8_t> blob;
};

struct OpenOptions {
  std::string db_filename;
  std::optional<std::string> db_location;
  bool read_only = false;
};

struct Envelope {
  bool ok = false;
  std::string message;
  std::optional<int> code;
  std::string db_id;
  std::int64_t insert_id = 0;
  std::int64_t rows_affected = 0;
  std::vector<std::string> column_names;
  std::vector<std::vector<Cell>> raw_rows;
};

enum class CoreLoad { kAutoExtension, kLoadExtension };

struct EngineConfig {
  CoreLoad core_load = CoreLoad::kAutoExtension;
  std::string core_path;
};

using Callback = std::function<void(Envelope)>;

class Engine {
 public:
  explicit Engine(EngineConfig config);
  ~Engine();

  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  void open(OpenOptions options, Callback cb);
  void close(std::string db_id, Callback cb);
  void execute(std::string db_id, std::string sql, std::vector<BindValue> params,
               Callback cb);
  void execute_batch(std::string db_id, std::string sql,
                     std::vector<std::vector<BindValue>> params, Callback cb);

 private:
  struct Impl;
  Impl* impl_;
};

Envelope fail(std::string message, std::optional<int> code = std::nullopt);

}  // namespace ps_sql

#endif
