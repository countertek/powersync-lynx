#include "HostConfig.h"

#include <windows.h>
#include <shellapi.h>

#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <vector>

#include "win_utf8.h"

namespace {

std::string EscapeJson(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (unsigned char c : input) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  return out;
}

std::vector<std::string> ProcessArgsUtf8() {
  std::vector<std::string> out;
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv == nullptr) {
    return out;
  }
  out.reserve(static_cast<size_t>(argc));
  for (int i = 0; i < argc; ++i) {
    out.push_back(ps_sql::WideToUtf8(argv[i]));
  }
  LocalFree(argv);
  return out;
}

std::string GetEnvUtf8(const wchar_t* name) {
  DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
  if (needed == 0) {
    return "";
  }
  std::wstring buf(needed, L'\0');
  DWORD written = GetEnvironmentVariableW(name, &buf[0], needed);
  if (written == 0 || written >= needed) {
    return "";
  }
  buf.resize(written);
  return ps_sql::WideToUtf8(buf);
}

bool FileExistsUtf8(const std::string& path) {
  std::wstring wide = ps_sql::Utf8ToWide(path);
  if (wide.empty()) {
    return false;
  }
  DWORD attrs = GetFileAttributesW(wide.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES &&
         (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::string ReadOption(const std::vector<std::string>& args,
                       const std::vector<std::string>& flags,
                       const wchar_t* env_name,
                       const std::string& fallback) {
  for (size_t i = 1; i < args.size(); ++i) {
    for (const auto& flag : flags) {
      if (args[i] == flag && i + 1 < args.size() && !args[i + 1].empty()) {
        return args[i + 1];
      }
    }
  }
  std::string env_val = GetEnvUtf8(env_name);
  if (!env_val.empty()) {
    return env_val;
  }
  return fallback;
}

bool HasFlag(const std::vector<std::string>& args,
             const std::string& flag,
             const wchar_t* env_name) {
  for (size_t i = 1; i < args.size(); ++i) {
    if (args[i] == flag) {
      return true;
    }
  }
  std::string env_val = GetEnvUtf8(env_name);
  return env_val == "1" || env_val == "true" || env_val == "TRUE";
}

std::string ResolveDefaultBundlePath() {
  std::string exe_dir = ExecutableDirectoryUtf8();
  if (!exe_dir.empty()) {
    std::string beside_exe = exe_dir + "\\main.lynx.bundle";
    if (FileExistsUtf8(beside_exe)) {
      return beside_exe;
    }
  }
#ifdef POWERSYNC_DEFAULT_BUNDLE_PATH
  std::string build_path = POWERSYNC_DEFAULT_BUNDLE_PATH;
  if (FileExistsUtf8(build_path)) {
    return build_path;
  }
#endif
  return "main.lynx.bundle";
}

}  // namespace

std::string ExecutableDirectoryUtf8() {
  std::wstring path(32768, L'\0');
  DWORD len = GetModuleFileNameW(nullptr, &path[0],
                                 static_cast<DWORD>(path.size()));
  if (len == 0 || len >= path.size()) {
    return "";
  }
  path.resize(len);
  size_t slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) {
    return "";
  }
  return ps_sql::WideToUtf8(path.substr(0, slash));
}

HostConfig HostConfig::FromProcess() {
  std::vector<std::string> args = ProcessArgsUtf8();

  HostConfig config;
  config.device =
      ReadOption(args, {"-DemoDevice", "--device"}, L"DEMO_DEVICE", "windows");
  config.demo_api_url =
      ReadOption(args, {"-DemoApiUrl", "--demo-api-url"}, L"DEMO_API_URL",
                 "http://127.0.0.1:8081");
  config.powersync_url =
      ReadOption(args, {"-PowerSyncUrl", "--powersync-url"}, L"POWERSYNC_URL",
                 "http://127.0.0.1:8080");
  config.bundle_path =
      ReadOption(args, {"-BundlePath", "--bundle"}, L"LYNX_BUNDLE_PATH",
                 ResolveDefaultBundlePath());
  config.exit_file =
      ReadOption(args, {"-ExitFile", "--exit-file"}, L"POWERSYNC_EXIT_FILE", "");
  config.smoke_test = HasFlag(args, "--smoke-test", L"SMOKE_TEST");
  config.headless = HasFlag(args, "--headless", L"HEADLESS");
  config.e2e = HasFlag(args, "--e2e", L"POWERSYNC_E2E");

  std::string seconds_str =
      ReadOption(args, {"--smoke-seconds"}, L"SMOKE_TEST_SECONDS", "");
  if (!seconds_str.empty()) {
    double parsed = std::strtod(seconds_str.c_str(), nullptr);
    if (parsed > 0.0) {
      config.smoke_seconds = parsed;
    }
  }
  return config;
}

std::string HostConfig::GlobalPropsJson() const {
  std::ostringstream oss;
  oss << "{\"device\":\"" << EscapeJson(device)
      << "\",\"demoApiUrl\":\"" << EscapeJson(demo_api_url)
      << "\",\"powersyncUrl\":\"" << EscapeJson(powersync_url) << "\"";
  if (e2e) {
    oss << ",\"e2e\":true";
  }
  oss << "}";
  return oss.str();
}
