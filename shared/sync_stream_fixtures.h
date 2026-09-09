#pragma once

/**
 * Shared /sync/stream NDJSON fixtures (FM-PS-LYNX-008 F, issue #21).
 *
 * Canonical catalog: shared/fixtures/sync-stream.json
 * JS loads that file; native tests include this header and read the same path.
 *
 * Protocol after headers: onData* → onError? → onEnd (ADR-0003).
 */

#include "sync_http_policy.h"

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef PS_SYNC_STREAM_FIXTURES_PATH
#define PS_SYNC_STREAM_FIXTURES_PATH "shared/fixtures/sync-stream.json"
#endif

namespace ps_sync_fixtures {

inline const char* kPathStreamingId = "streamingId";
inline const char* kPathIdleComplete = "idleComplete";

struct Scenario {
  std::string id;
  std::string path;
  std::string error;
  std::vector<std::string> chunks;
  std::vector<std::string> events;
};

struct Catalog {
  std::string content_type;
  std::vector<std::string> idle_complete_keys;
  std::vector<std::string> streaming_keys;
  std::vector<Scenario> scenarios;
};

inline std::string joined_body(const Scenario& scenario) {
  std::string body;
  for (const auto& chunk : scenario.chunks) {
    body += chunk;
  }
  return body;
}

inline const Scenario* find_scenario(const Catalog& catalog, const char* id) {
  for (const auto& scenario : catalog.scenarios) {
    if (scenario.id == id) {
      return &scenario;
    }
  }
  return nullptr;
}

/** onData* (onError)? onEnd — the terminal sequence B aligned across hosts. */
inline bool valid_terminal_sequence(const std::vector<std::string>& events) {
  if (events.empty()) {
    return false;
  }
  if (events.back() != PS_SYNC_HTTP_EVENT_ON_END) {
    return false;
  }
  bool saw_error = false;
  for (size_t i = 0; i + 1 < events.size(); ++i) {
    const std::string& event = events[i];
    if (event == PS_SYNC_HTTP_EVENT_ON_DATA) {
      if (saw_error) {
        return false;
      }
      continue;
    }
    if (event == PS_SYNC_HTTP_EVENT_ON_ERROR) {
      if (saw_error) {
        return false;
      }
      saw_error = true;
      if (i + 2 != events.size()) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

inline bool incremental_data_before_end(const std::vector<std::string>& events) {
  if (!valid_terminal_sequence(events)) {
    return false;
  }
  bool saw_data = false;
  for (const auto& event : events) {
    if (event == PS_SYNC_HTTP_EVENT_ON_DATA) {
      saw_data = true;
    } else if (event == PS_SYNC_HTTP_EVENT_ON_END) {
      return saw_data;
    }
  }
  return false;
}

namespace json_detail {

class Parser {
 public:
  explicit Parser(std::string text) : text_(std::move(text)) {}

  void skip_ws() {
    while (i_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[i_]))) {
      ++i_;
    }
  }

  char peek() {
    skip_ws();
    if (i_ >= text_.size()) {
      throw std::runtime_error("unexpected end of JSON");
    }
    return text_[i_];
  }

  void eat(char expected) {
    skip_ws();
    if (i_ >= text_.size() || text_[i_] != expected) {
      throw std::runtime_error(std::string("expected '") + expected + "'");
    }
    ++i_;
  }

  std::string parse_string() {
    skip_ws();
    if (i_ >= text_.size() || text_[i_] != '"') {
      throw std::runtime_error("expected string");
    }
    ++i_;
    std::string out;
    while (i_ < text_.size()) {
      char c = text_[i_++];
      if (c == '"') {
        return out;
      }
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (i_ >= text_.size()) {
        throw std::runtime_error("unterminated escape");
      }
      char esc = text_[i_++];
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          out.push_back(esc);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        case 'u': {
          if (i_ + 4 > text_.size()) {
            throw std::runtime_error("bad unicode escape");
          }
          unsigned code = 0;
          for (int n = 0; n < 4; ++n) {
            char h = text_[i_++];
            code <<= 4;
            if (h >= '0' && h <= '9') {
              code += static_cast<unsigned>(h - '0');
            } else if (h >= 'a' && h <= 'f') {
              code += static_cast<unsigned>(h - 'a' + 10);
            } else if (h >= 'A' && h <= 'F') {
              code += static_cast<unsigned>(h - 'A' + 10);
            } else {
              throw std::runtime_error("bad unicode escape");
            }
          }
          if (code < 0x80) {
            out.push_back(static_cast<char>(code));
          } else if (code < 0x800) {
            out.push_back(static_cast<char>(0xc0 | (code >> 6)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3f)));
          } else {
            out.push_back(static_cast<char>(0xe0 | (code >> 12)));
            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3f)));
          }
          break;
        }
        default:
          throw std::runtime_error("unknown escape");
      }
    }
    throw std::runtime_error("unterminated string");
  }

  std::vector<std::string> parse_string_array() {
    eat('[');
    std::vector<std::string> items;
    skip_ws();
    if (peek() == ']') {
      eat(']');
      return items;
    }
    for (;;) {
      items.push_back(parse_string());
      skip_ws();
      if (peek() == ']') {
        eat(']');
        return items;
      }
      eat(',');
    }
  }

  void skip_value() {
    char c = peek();
    if (c == '"') {
      parse_string();
      return;
    }
    if (c == '{') {
      eat('{');
      skip_ws();
      if (peek() == '}') {
        eat('}');
        return;
      }
      for (;;) {
        parse_string();
        eat(':');
        skip_value();
        skip_ws();
        if (peek() == '}') {
          eat('}');
          return;
        }
        eat(',');
      }
    }
    if (c == '[') {
      eat('[');
      skip_ws();
      if (peek() == ']') {
        eat(']');
        return;
      }
      for (;;) {
        skip_value();
        skip_ws();
        if (peek() == ']') {
          eat(']');
          return;
        }
        eat(',');
      }
    }
    while (i_ < text_.size()) {
      char ch = text_[i_];
      if (ch == ',' || ch == '}' || ch == ']' || std::isspace(static_cast<unsigned char>(ch))) {
        break;
      }
      ++i_;
    }
  }

  Scenario parse_scenario() {
    eat('{');
    Scenario scenario;
    skip_ws();
    if (peek() == '}') {
      eat('}');
      return scenario;
    }
    for (;;) {
      std::string key = parse_string();
      eat(':');
      if (key == "id") {
        scenario.id = parse_string();
      } else if (key == "path") {
        scenario.path = parse_string();
      } else if (key == "error") {
        scenario.error = parse_string();
      } else if (key == "chunks") {
        scenario.chunks = parse_string_array();
      } else if (key == "events") {
        scenario.events = parse_string_array();
      } else {
        skip_value();
      }
      skip_ws();
      if (peek() == '}') {
        eat('}');
        return scenario;
      }
      eat(',');
    }
  }

  std::vector<Scenario> parse_scenario_array() {
    eat('[');
    std::vector<Scenario> items;
    skip_ws();
    if (peek() == ']') {
      eat(']');
      return items;
    }
    for (;;) {
      items.push_back(parse_scenario());
      skip_ws();
      if (peek() == ']') {
        eat(']');
        return items;
      }
      eat(',');
    }
  }

  Catalog parse_catalog() {
    eat('{');
    Catalog catalog;
    skip_ws();
    if (peek() == '}') {
      eat('}');
      return catalog;
    }
    for (;;) {
      std::string key = parse_string();
      eat(':');
      if (key == "contentType") {
        catalog.content_type = parse_string();
      } else if (key == "idleCompleteEnvelopeKeys") {
        catalog.idle_complete_keys = parse_string_array();
      } else if (key == "streamingEnvelopeKeys") {
        catalog.streaming_keys = parse_string_array();
      } else if (key == "scenarios") {
        catalog.scenarios = parse_scenario_array();
      } else {
        skip_value();
      }
      skip_ws();
      if (peek() == '}') {
        eat('}');
        break;
      }
      eat(',');
    }
    skip_ws();
    if (i_ != text_.size()) {
      throw std::runtime_error("trailing JSON content");
    }
    return catalog;
  }

 private:
  std::string text_;
  size_t i_ = 0;
};

}  // namespace json_detail

inline std::string read_file(const char* path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error(std::string("cannot open fixture file: ") + path);
  }
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

inline Catalog parse_json(const std::string& json) {
  json_detail::Parser parser(json);
  return parser.parse_catalog();
}

inline Catalog load_path(const char* path) {
  return parse_json(read_file(path));
}

inline Catalog load_default() {
  const char* from_env = std::getenv("PS_SYNC_STREAM_FIXTURES_PATH");
  const char* path =
      from_env != nullptr && from_env[0] != '\0' ? from_env : PS_SYNC_STREAM_FIXTURES_PATH;
  return load_path(path);
}

inline bool has_key(const std::vector<std::string>& keys, const char* want) {
  for (const auto& key : keys) {
    if (key == want) {
      return true;
    }
  }
  return false;
}

}  // namespace ps_sync_fixtures
