#include "sync_http_policy.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef PS_SYNC_HTTP_POLICY_H_PATH
#define PS_SYNC_HTTP_POLICY_H_PATH "shared/sync_http_policy.h"
#endif
#ifndef PS_ANDROID_JAVA_DIR
#define PS_ANDROID_JAVA_DIR "android/src/main/java/com/powersync/lynx"
#endif

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

std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("cannot read " + path);
  }
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

std::string java_path(const char* file) {
  return std::string(PS_ANDROID_JAVA_DIR) + "/" + file;
}

std::string strip_comments(const std::string& src) {
  std::string out;
  out.reserve(src.size());
  for (size_t i = 0; i < src.size();) {
    if (src[i] == '"') {
      out.push_back(src[i++]);
      while (i < src.size()) {
        out.push_back(src[i]);
        if (src[i] == '\\' && i + 1 < src.size()) {
          out.push_back(src[i + 1]);
          i += 2;
          continue;
        }
        if (src[i] == '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (i + 1 < src.size() && src[i] == '/' && src[i + 1] == '/') {
      while (i < src.size() && src[i] != '\n') {
        i += 1;
      }
      continue;
    }
    if (i + 1 < src.size() && src[i] == '/' && src[i + 1] == '*') {
      i += 2;
      while (i + 1 < src.size() && !(src[i] == '*' && src[i + 1] == '/')) {
        i += 1;
      }
      if (i + 1 < src.size()) {
        i += 2;
      } else {
        i = src.size();
      }
      continue;
    }
    out.push_back(src[i]);
    i += 1;
  }
  return out;
}

std::string trim(const std::string& s) {
  size_t b = 0;
  while (b < s.size() && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r')) {
    b += 1;
  }
  size_t e = s.size();
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r')) {
    e -= 1;
  }
  return s.substr(b, e - b);
}

struct PolicyValue {
  enum Kind { kInt, kString };
  Kind kind;
  long long integer;
  std::string text;

  std::string debug() const {
    if (kind == kString) {
      return "\"" + text + "\"";
    }
    return std::to_string(integer);
  }
};

bool parse_literal(const std::string& raw, PolicyValue* out) {
  if (raw.size() >= 2 && raw.front() == '"' && raw.back() == '"') {
    out->kind = PolicyValue::kString;
    out->integer = 0;
    out->text = raw.substr(1, raw.size() - 2);
    return true;
  }
  std::string digits;
  digits.reserve(raw.size());
  for (char ch : raw) {
    if (ch == '_') {
      continue;
    }
    if (ch == 'L' || ch == 'l') {
      continue;
    }
    digits.push_back(ch);
  }
  if (digits.empty()) {
    return false;
  }
  char* end = nullptr;
  const long long n = std::strtoll(digits.c_str(), &end, 10);
  if (end == digits.c_str() || *end != '\0') {
    return false;
  }
  out->kind = PolicyValue::kInt;
  out->integer = n;
  out->text.clear();
  return true;
}

using PolicyMap = std::map<std::string, PolicyValue>;

PolicyMap parse_header_macros(const std::string& source) {
  PolicyMap macros;
  const std::string body = strip_comments(source);
  std::istringstream in(body);
  std::string line;
  const std::string prefix = "PS_SYNC_HTTP_";
  while (std::getline(in, line)) {
    std::string t = trim(line);
    if (t.rfind("#define", 0) != 0) {
      continue;
    }
    t = trim(t.substr(7));
    if (t.rfind(prefix, 0) != 0) {
      continue;
    }
    size_t name_end = 0;
    while (name_end < t.size() &&
           ((t[name_end] >= 'A' && t[name_end] <= 'Z') ||
            (t[name_end] >= '0' && t[name_end] <= '9') || t[name_end] == '_')) {
      name_end += 1;
    }
    if (name_end < t.size() && t[name_end] == '(') {
      continue;
    }
    const std::string name = t.substr(0, name_end);
    const std::string value = trim(t.substr(name_end));
    if (value.empty()) {
      continue;
    }
    PolicyValue parsed;
    if (!parse_literal(value, &parsed)) {
      throw std::runtime_error("bad header literal for " + name + ": " + value);
    }
    macros[name.substr(prefix.size())] = parsed;
  }
  return macros;
}

PolicyMap parse_java_constants(const std::string& source) {
  PolicyMap constants;
  const std::string body = strip_comments(source);
  const std::string needle = "static";
  size_t pos = 0;
  while ((pos = body.find(needle, pos)) != std::string::npos) {
    std::string rest = trim(body.substr(pos + needle.size()));
    if (rest.rfind("final", 0) != 0) {
      pos += needle.size();
      continue;
    }
    rest = trim(rest.substr(5));
    std::string type;
    if (rest.rfind("long", 0) == 0) {
      type = "long";
      rest = trim(rest.substr(4));
    } else if (rest.rfind("String", 0) == 0) {
      type = "String";
      rest = trim(rest.substr(6));
    } else {
      pos += needle.size();
      continue;
    }
    size_t name_end = 0;
    while (name_end < rest.size() &&
           ((rest[name_end] >= 'A' && rest[name_end] <= 'Z') ||
            (rest[name_end] >= '0' && rest[name_end] <= '9') || rest[name_end] == '_')) {
      name_end += 1;
    }
    if (name_end == 0) {
      pos += needle.size();
      continue;
    }
    const std::string name = rest.substr(0, name_end);
    rest = trim(rest.substr(name_end));
    if (rest.empty() || rest[0] != '=') {
      pos += needle.size();
      continue;
    }
    rest = trim(rest.substr(1));
    const size_t semi = rest.find(';');
    if (semi == std::string::npos) {
      pos += needle.size();
      continue;
    }
    PolicyValue parsed;
    if (!parse_literal(trim(rest.substr(0, semi)), &parsed)) {
      throw std::runtime_error("bad Java literal for " + name);
    }
    if (type == "long" && parsed.kind != PolicyValue::kInt) {
      throw std::runtime_error("Java long " + name + " is not an integer");
    }
    if (type == "String" && parsed.kind != PolicyValue::kString) {
      throw std::runtime_error("Java String " + name + " is not a string");
    }
    constants[name] = parsed;
    pos += needle.size();
  }
  return constants;
}

bool values_equal(const PolicyValue& a, const PolicyValue& b) {
  if (a.kind != b.kind) {
    return false;
  }
  if (a.kind == PolicyValue::kString) {
    return a.text == b.text;
  }
  return a.integer == b.integer;
}

void expect_maps_equal(const PolicyMap& left, const PolicyMap& right, const char* what) {
  auto it_l = left.begin();
  auto it_r = right.begin();
  bool ok = left.size() == right.size();
  std::string detail;
  while (it_l != left.end() && it_r != right.end()) {
    if (it_l->first != it_r->first || !values_equal(it_l->second, it_r->second)) {
      ok = false;
      detail += " mismatch " + it_l->first + "=" + it_l->second.debug() + " vs " + it_r->first +
                "=" + it_r->second.debug();
    }
    ++it_l;
    ++it_r;
  }
  if (it_l != left.end() || it_r != right.end()) {
    ok = false;
    detail += " key-set size differs";
  }
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s%s\n", what, detail.c_str());
    ++g_failures;
    return;
  }
  std::printf("ok: %s\n", what);
}

void expect_compiled_int(const PolicyMap& parsed, const char* name, long long compiled) {
  auto it = parsed.find(name);
  if (it == parsed.end() || it->second.kind != PolicyValue::kInt ||
      it->second.integer != compiled) {
    std::fprintf(stderr, "FAIL: parsed %s != compiled %lld\n", name, compiled);
    ++g_failures;
    return;
  }
  std::printf("ok: parsed %s matches compiled macro\n", name);
}

void expect_compiled_str(const PolicyMap& parsed, const char* name, const char* compiled) {
  auto it = parsed.find(name);
  if (it == parsed.end() || it->second.kind != PolicyValue::kString ||
      it->second.text != compiled) {
    std::fprintf(stderr, "FAIL: parsed %s != compiled %s\n", name, compiled);
    ++g_failures;
    return;
  }
  std::printf("ok: parsed %s matches compiled macro\n", name);
}

bool contains(const std::string& hay, const char* needle) {
  return hay.find(needle) != std::string::npos;
}

}  // namespace

int main() {
  try {
    const std::string header_src = read_file(PS_SYNC_HTTP_POLICY_H_PATH);
    const std::string java_src = read_file(java_path("SyncHttpPolicy.java"));
    const PolicyMap header = parse_header_macros(header_src);
    const PolicyMap java = parse_java_constants(java_src);

    expect(!header.empty(), "header parse found PS_SYNC_HTTP_ macros");
    expect(!java.empty(), "Java parse found static final constants");
    expect_maps_equal(header, java, "C header macros equal Android SyncHttpPolicy.java");

    expect_compiled_int(header, "IDLE_COMPLETE_MS", PS_SYNC_HTTP_IDLE_COMPLETE_MS);
    expect_compiled_int(header, "CONNECT_TIMEOUT_MS", PS_SYNC_HTTP_CONNECT_TIMEOUT_MS);
    expect_compiled_int(header, "BUFFERED_READ_TIMEOUT_MS", PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS);
    expect_compiled_int(header, "STREAM_READ_TIMEOUT_MS", PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS);
    expect_compiled_int(header, "STREAM_RESOURCE_TIMEOUT_MS",
                        PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS);
    expect_compiled_str(header, "STREAM_EVENT_PREFIX", PS_SYNC_HTTP_STREAM_EVENT_PREFIX);
    expect_compiled_str(header, "EVENT_ON_DATA", PS_SYNC_HTTP_EVENT_ON_DATA);
    expect_compiled_str(header, "EVENT_ON_ERROR", PS_SYNC_HTTP_EVENT_ON_ERROR);
    expect_compiled_str(header, "EVENT_ON_END", PS_SYNC_HTTP_EVENT_ON_END);

    expect_compiled_int(java, "IDLE_COMPLETE_MS", PS_SYNC_HTTP_IDLE_COMPLETE_MS);
    expect_compiled_int(java, "CONNECT_TIMEOUT_MS", PS_SYNC_HTTP_CONNECT_TIMEOUT_MS);
    expect_compiled_int(java, "BUFFERED_READ_TIMEOUT_MS", PS_SYNC_HTTP_BUFFERED_READ_TIMEOUT_MS);
    expect_compiled_int(java, "STREAM_READ_TIMEOUT_MS", PS_SYNC_HTTP_STREAM_READ_TIMEOUT_MS);
    expect_compiled_int(java, "STREAM_RESOURCE_TIMEOUT_MS",
                        PS_SYNC_HTTP_STREAM_RESOURCE_TIMEOUT_MS);
    expect_compiled_str(java, "STREAM_EVENT_PREFIX", PS_SYNC_HTTP_STREAM_EVENT_PREFIX);
    expect_compiled_str(java, "EVENT_ON_DATA", PS_SYNC_HTTP_EVENT_ON_DATA);
    expect_compiled_str(java, "EVENT_ON_ERROR", PS_SYNC_HTTP_EVENT_ON_ERROR);
    expect_compiled_str(java, "EVENT_ON_END", PS_SYNC_HTTP_EVENT_ON_END);

    const std::vector<const char*> consumers = {
        "IdleCompleteHttp.java",
        "StreamingHttp.java",
        "NativeSyncHttp.java",
    };
    for (const char* file : consumers) {
      const std::string src = read_file(java_path(file));
      const std::string stripped = strip_comments(src);
      expect(contains(src, "SyncHttpPolicy."),
             (std::string(file) + " references SyncHttpPolicy").c_str());
      expect(!contains(stripped, "static final long"),
             (std::string(file) + " does not redeclare long policy constants").c_str());
      expect(!contains(stripped, "static final String STREAM_EVENT_PREFIX"),
             (std::string(file) + " does not redeclare STREAM_EVENT_PREFIX").c_str());
    }
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "FAIL: %s\n", ex.what());
    return 1;
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "%d Android sync-HTTP policy check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all Android sync-HTTP policy equality checks passed\n");
  return 0;
}
